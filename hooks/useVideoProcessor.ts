import { useState, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import type { GenerateContentResponse, Part } from "@google/genai";
import type { ProcessingState, DialogueSegment, SpeakerProfile, TranslatedSegment } from '../types';
import { VOICE_LIST } from '../constants';

// Helper function to convert blob to base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result as string;
      resolve(base64data.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function manualDecodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const frameCount = data.byteLength / 2 / numChannels;
  if (frameCount <= 0) {
    return ctx.createBuffer(numChannels, 0, sampleRate);
  }
  
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      const byteOffset = (i * numChannels + channel) * 2;
      const sample = view.getInt16(byteOffset, true);
      channelData[i] = sample / 32768.0;
    }
  }
  return buffer;
}

const audioBufferToWavBlob = (buffer: AudioBuffer): Blob => {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; 
  const bitDepth = 16;

  const data = new Float32Array(buffer.length);
  buffer.copyFromChannel(data, 0);
  const result = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = Math.max(-1, Math.min(1, data[i])) * 0x7FFF;
  }

  const dataLength = result.length * (bitDepth / 8);
  const bufferLength = 44 + dataLength;
  const wavBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(wavBuffer);

  function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  let offset = 0;
  writeString(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, 36 + dataLength, true); offset += 4;
  writeString(view, offset, 'WAVE'); offset += 4;
  writeString(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, format, true); offset += 2;
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * numChannels * (bitDepth / 8), true); offset += 4;
  view.setUint16(offset, numChannels * (bitDepth / 8), true); offset += 2;
  view.setUint16(offset, bitDepth, true); offset += 2;
  writeString(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataLength, true); offset += 4;

  for (let i = 0; i < result.length; i++, offset += 2) {
    view.setInt16(offset, result[i], true);
  }

  return new Blob([view], { type: 'audio/wav' });
};

export const useVideoProcessor = (apiKey: string) => {  // <-- API key param here
  const [processingState, setProcessingState] = useState<ProcessingState>({ status: 'idle', progress: 0 });
  const [progressMessage, setProgressMessage] = useState('');
  const [dubbedVideoUrl, setDubbedVideoUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ttsLogs, setTtsLogs] = useState<string[]>([]);

  const appendTtsLog = useCallback((msg: string) => {
    setTtsLogs(prev => [...prev, msg]);
  }, []);

  const processVideo = useCallback(async (videoFile: File, targetLang: string) => {
    if (!apiKey) {
      setError('API key is missing. Please enter your API key.');
      setProcessingState({ status: 'error', progress: 0 });
      return;
    }
    setProcessingState({ status: 'processing', progress: 0 });
    setError(null);
    setTtsLogs([]);

    let tempVideoUrl = '';
    let videoElement: HTMLVideoElement | null = document.createElement('video');
    let audioContext: AudioContext | null = null;

    try {
      const ai = new GoogleGenAI({ apiKey });  // use passed apiKey here
      tempVideoUrl = URL.createObjectURL(videoFile);
      videoElement.src = tempVideoUrl;

      await new Promise<void>((resolve, reject) => {
        videoElement!.onloadedmetadata = () => resolve();
        videoElement!.onerror = (e) => reject('Error loading video metadata: ' + e);
      });

      const duration = videoElement.duration;

      setProgressMessage('Extracting audio from video');
      setProcessingState({ status: 'processing', progress: 5 });

      const tempAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const videoArrayBuffer = await videoFile.arrayBuffer();
      const decodedAudioBuffer = await tempAudioContext.decodeAudioData(videoArrayBuffer);
      const resampledLength = Math.ceil(duration * 44100);
      const offlineAudioContext = new OfflineAudioContext(1, resampledLength, 44100);
      const source = offlineAudioContext.createBufferSource();
      source.buffer = decodedAudioBuffer;
      source.connect(offlineAudioContext.destination);
      source.start(0);
      const fullAudioBuffer = await offlineAudioContext.startRendering();
      await tempAudioContext.close();

      setProgressMessage('Transcribing dialogue');
      setProcessingState({ status: 'processing', progress: 15 });

      const audioWavBlob = audioBufferToWavBlob(fullAudioBuffer);
      const audioBase64 = await blobToBase64(audioWavBlob);

      const transcriptionPrompt = 'You are an expert audio analyst. Transcribe the provided audio and perform speaker diarization. Identify each speaker with a unique ID like "Speaker 1". Provide precise start and end timestamps in seconds for each dialogue segment. Respond ONLY with a JSON array of objects following this exact schema: [{ "speakerId": string, "startTime": number, "endTime": number, "transcription": string }]';

      const audioPart = { inlineData: { mimeType: 'audio/wav', data: audioBase64 } };
      const textPart = { text: transcriptionPrompt };

      const transcriptionResponse = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: { parts: [audioPart, textPart] },
        config: { responseMimeType: 'application/json' }
      });

      const allDialogueSegments: DialogueSegment[] = JSON.parse(transcriptionResponse.text);

      if (allDialogueSegments.length === 0) throw new Error("No speech was detected in the video.");

      setProgressMessage('Analyzing speakers');
      setProcessingState({ status: 'processing', progress: 40 });
      const speakerProfiles = new Map<string, SpeakerProfile>();
      const uniqueSpeakerIds = [...new Set(allDialogueSegments.map(s => s.speakerId))];

      const voiceCatalog = VOICE_LIST.map(v => '- ' + v.name + ' (' + v.gender + '): ' + v.description).join('\n');

      for (const speakerId of uniqueSpeakerIds) {
        const segmentsForSpeaker = allDialogueSegments.filter(s => s.speakerId === speakerId);
        if (segmentsForSpeaker.length === 0) continue;
        const speakerTextContext = segmentsForSpeaker.map(s => s.transcription).join(' ');
        const frameTimestamps = [...new Set([
          segmentsForSpeaker[0].startTime,
          segmentsForSpeaker[Math.floor(segmentsForSpeaker.length / 2)].startTime,
          segmentsForSpeaker[segmentsForSpeaker.length - 1].startTime
        ])];
        const frameParts: Part[] = [];
        for (const timestamp of frameTimestamps) {
          videoElement.currentTime = timestamp;
          await new Promise(resolve => { videoElement!.onseeked = resolve; });
          const canvas = document.createElement('canvas');
          canvas.width = videoElement.videoWidth;
          canvas.height = videoElement.videoHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
          const frameBlob: Blob = await new Promise(resolve => canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.8));
          const frameBase64 = await blobToBase64(frameBlob);
          frameParts.push({ inlineData: { mimeType: 'image/jpeg', data: frameBase64 } });
        }

        const analysisPrompt =
          'You are an expert voice casting director. Your task is to create a profile for a speaker for voice dubbing.\n\n' +
          'Analyze the speaker\'s likely gender, age, and emotional tone based on the provided images and their dialogue.\n\n' +
          'Then, review the following catalog of available voices and select the single best voice that matches the speaker\'s profile.\n\n' +
          '**Available Voice Catalog:**\n' + voiceCatalog + '\n\n' +
          '**Dialogue Context:** "' + speakerTextContext + '"\n\n' +
          'Respond ONLY with a single JSON object with this exact structure: { "gender": "string", "age": "string", "emotion": "string", "voiceName": "string" }.\n' +
          'The value for "voiceName" MUST be one of the names from the "Available Voice Catalog" provided above.';

        const analysisResponse = await ai.models.generateContent({
          model: 'gemini-2.5-pro',
          contents: { parts: [...frameParts, { text: analysisPrompt }] },
          config: { responseMimeType: 'application/json' }
        });

        const analysisResult: Omit<SpeakerProfile, 'id'> = JSON.parse(analysisResponse.text);
        speakerProfiles.set(speakerId, { id: speakerId, ...analysisResult });
      }

      setProgressMessage('Translating dialogue');
      setProcessingState({ status: 'processing', progress: 60 });
      const translatedSegments: TranslatedSegment[] = [];
      const transcriptionBatch = allDialogueSegments.map(s => s.transcription).join('\n---\n');
      const translationPrompt =
        'Translate the following text snippets into ' + targetLang + '. Snippets are separated by \'---\'. Maintain this separation.\n---\n' +
        transcriptionBatch;

      const translationResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: translationPrompt
      });

      const translatedTexts = translationResponse.text.split('\n---\n').map(t => t.trim());
      allDialogueSegments.forEach((segment, i) => {
        translatedSegments.push({ ...segment, text: translatedTexts[i] || "" });
      });

      setProgressMessage('Generating dubbed audio');
      setProcessingState({ status: 'processing', progress: 75 });
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const fullDubAudioBuffer = audioContext.createBuffer(1, Math.ceil(duration * 24000), 24000);
      const mainChannelData = fullDubAudioBuffer.getChannelData(0);
      let audioGeneratedSuccessfully = false;

      for (const segment of translatedSegments) {
        if (!segment.text.trim()) continue;
        const speakerProfile = speakerProfiles.get(segment.speakerId);
        if (!speakerProfile || !speakerProfile.voiceName) continue;

        appendTtsLog('[TTS][REQUEST] Segment text: ' + segment.text + '\nSpeaker Profile: ' + JSON.stringify(speakerProfile));

        try {
          const audioResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: segment.text }] }],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: speakerProfile.voiceName } } }
            }
          });

          appendTtsLog('[TTS][RESPONSE][RAW]: ' + JSON.stringify(audioResponse));

          const audioDataB64 = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (audioDataB64) {
            audioGeneratedSuccessfully = true;
            const audioBytes = decode(audioDataB64);
            const segmentAudioBuffer = await manualDecodeAudioData(audioBytes, audioContext, 24000, 1);
            const startSample = Math.floor(segment.startTime * 24000);
            const segmentChannelData = segmentAudioBuffer.getChannelData(0);
            if (startSample + segmentChannelData.length <= mainChannelData.length) {
              mainChannelData.set(segmentChannelData, startSample);
            }
          } else {
            appendTtsLog('[TTS][ERROR] No audio data returned for segment "' + segment.text + '". Raw response: ' + JSON.stringify(audioResponse));
          }
        } catch (ttsError) {
          appendTtsLog('[TTS][EXCEPTION] for segment "' + segment.text + '": ' + JSON.stringify(ttsError));
        }
      }

      if (!audioGeneratedSuccessfully) {
        throw new Error('Audio generation failed for all dialogue segments. Please check the TTS Logs section in your UI for specific API errors.');
      }

      setProgressMessage('Reconstructing final video');
      setProcessingState({ status: 'processing', progress: 95 });

      if (audioContext && audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const videoStream = (videoElement as any).captureStream();
      const videoTrack = videoStream.getVideoTracks()[0];

      const audioDestination = audioContext.createMediaStreamDestination();
      const bufferSource = audioContext.createBufferSource();
      bufferSource.buffer = fullDubAudioBuffer;
      bufferSource.connect(audioDestination);
      const audioTrack = audioDestination.stream.getAudioTracks()[0];

      const combinedStream = new MediaStream([videoTrack, audioTrack]);
      const recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm' });
      const recordedChunks: Blob[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.push(event.data);
      };

      const recordingPromise = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          if (blob.size === 0) {
            reject(new Error('Recording resulted in an empty file, likely due to a media pipeline issue.'));
            return;
          }
          setDubbedVideoUrl(URL.createObjectURL(blob));
          resolve();
        };
        recorder.onerror = (event) => reject((event as any).error || new Error('A MediaRecorder error occurred.'));
      });

      videoElement.onended = () => {
        if (recorder.state === 'recording') recorder.stop();
      };

      videoElement.currentTime = 0;
      videoElement.muted = true;
      bufferSource.start(0);
      await videoElement.play();
      recorder.start();

      await recordingPromise;
      setProcessingState({ status: 'done', progress: 100 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred during processing.');
      setProcessingState({ status: 'error', progress: 0 });
    } finally {
      if (tempVideoUrl) URL.revokeObjectURL(tempVideoUrl);
      if (videoElement) videoElement.remove();
      if (audioContext && audioContext.state !== 'closed') audioContext.close();
    }
  }, [appendTtsLog]);

  return { processingState, progressMessage, dubbedVideoUrl, error, processVideo, ttsLogs };
};
