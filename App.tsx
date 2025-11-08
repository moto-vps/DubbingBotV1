import React, { useState, useCallback } from 'react';
import { FileUpload } from './components/FileUpload';
import { ProcessingView } from './components/ProcessingView';
import { ResultView } from './components/ResultView';
import { useVideoProcessor } from './hooks/useVideoProcessor';
import type { ProcessingState } from './types';

const App: React.FC = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [targetLang, setTargetLang] = useState<string>('es');
  const [apiKey, setApiKey] = useState<string>('');
  const { processingState, progressMessage, dubbedVideoUrl, error, processVideo, ttsLogs } = useVideoProcessor(apiKey);

  const handleStartProcessing = useCallback(() => {
    if (!apiKey) {
      alert('Please enter your Gemini API key.');
      return;
    }
    if (videoFile) {
      processVideo(videoFile, targetLang);
    }
  }, [videoFile, targetLang, processVideo, apiKey]);

  const handleReset = () => {
    setVideoFile(null);
    // The hook state will be reset internally when processVideo is called again
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setApiKey(e.target.value);
  };

  const renderContent = () => {
    switch (processingState.status) {
      case 'processing':
        return <ProcessingView progressMessage={progressMessage} progressPercent={processingState.progress} ttsLogs={ttsLogs} />;
      case 'error':
        return (
          <div className="text-center p-8 bg-red-900/20 rounded-lg">
            <h2 className="text-2xl font-bold text-red-400 mb-4">An Error Occurred</h2>
            <p className="text-red-300">{error}</p>
            <button
              onClick={handleReset}
              className="mt-6 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg transition-colors"
            >
              Try Again
            </button>
          </div>
        );
      case 'done':
        return <ResultView originalVideoUrl={URL.createObjectURL(videoFile!)} dubbedVideoUrl={dubbedVideoUrl} onReset={handleReset} />;
      case 'idle':
      default:
        return (
          <>
            <div className="mb-6">
              <label className="block mb-2 font-semibold" htmlFor="apiKeyInput">Enter your Gemini API Key</label>
              <input
                id="apiKeyInput"
                type="password"
                value={apiKey}
                onChange={handleApiKeyChange}
                className="w-full p-2 rounded-md bg-gray-700 border border-gray-600 text-gray-100"
                placeholder="Paste your Gemini API Key here"
              />
            </div>
            <FileUpload
              videoFile={videoFile}
              setVideoFile={setVideoFile}
              targetLang={targetLang}
              setTargetLang={setTargetLang}
              onStart={handleStartProcessing}
              isProcessing={processingState.status !== 'idle'}
            />
          </>
        );
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-4xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
            Gemini Video Dubber
          </h1>
          <p className="text-gray-400 mt-2 text-lg">
            Upload a video, and we'll transcribe, translate, and re-voice it in another language.
          </p>
        </header>
        <main className="bg-gray-800/50 backdrop-blur-sm p-6 sm:p-8 rounded-2xl shadow-2xl border border-gray-700">
          {renderContent()}
        </main>
        <footer className="text-center mt-8 text-gray-500 text-sm">
          <p>Powered by Gemini. For demonstration purposes only.</p>
        </footer>
      </div>
    </div>
  );
};

export default App;
