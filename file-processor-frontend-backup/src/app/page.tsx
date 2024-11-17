'use client';
import { useState } from 'react';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [fileId, setFileId] = useState('');
  const [uploadComplete, setUploadComplete] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const handleUpload = async () => {
    try {
      // let user know we're starting
      console.log('Starting upload process...');
      setIsLoading(true);

      let uploadUrl: string;
      let fileKey: string;

      if (file) {
        // if they uploaded a file, handle that first
        console.log('Uploading file:', file.name);
        const urlResponse = await fetch(`/api/get-upload-url?filename=${file.name}`);
        if (!urlResponse.ok) {
          throw new Error('Failed to get upload URL');
        }
        const data = await urlResponse.json();
        uploadUrl = data.uploadUrl;
        fileKey = data.fileKey;

        // push the file to s3
        const uploadResponse = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: {
            'Content-Type': 'text/plain',
          },
        })

        if (!uploadResponse.ok) {
          throw new Error('Failed to upload file');
        }
      } else if (text) {
        // if they typed text, handle that instead
        console.log('Uploading text input');
        const timestamp = new Date().getTime();
        const filename = `input-${timestamp}.txt`;
        
        // get a url to upload to
        const urlResponse = await fetch(`/api/get-upload-url?filename=${filename}`);
        if (!urlResponse.ok) {
          throw new Error('Failed to get upload URL');
        }
        const data = await urlResponse.json();
        uploadUrl = data.uploadUrl;
        fileKey = data.fileKey;

        // turn the text into a file and upload it
        const blob = new Blob([text], { type: 'text/plain' });
        const uploadResponse = await fetch(uploadUrl, {
          method: 'PUT',
          body: blob,
          headers: {
            'Content-Type': 'text/plain',
          },
        });

        if (!uploadResponse.ok) {
          throw new Error('Failed to upload file');
        }
      } else {
        throw new Error('Please either enter text or select a file');
      }

      // save the details to dynamodb
      const metadataResponse = await fetch('/api/create-entry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text || await file?.text() || '',
          file_path: fileKey,
        }),
      });

      if (!metadataResponse.ok) {
        throw new Error('Failed to store metadata');
      }

      const data = await metadataResponse.json();
      if (data.id) {
        setFileId(data.id);
        setUploadComplete(true);
        
        // kick off the processing
        console.log('Starting automatic processing...');
        const processResponse = await fetch(`/api/process/${data.id}`, {
          method: 'POST',
        });
        
        if (!processResponse.ok) {
          throw new Error('Failed to start processing');
        }
        
        // show success message for 5 seconds
        setShowSuccess(true);
        setTimeout(() => setShowSuccess(false), 5000);
        console.log('Processing started');
      }

    } catch (error) {
      // something went wrong, let the user know
      console.error('Upload/Process error:', error);
      alert('Failed to upload/process: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      // clean up loading state
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      <div className="max-w-4xl mx-auto p-6 md:p-8">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500 mb-4">
            Text Summarizer
          </h1>
          <p className="text-gray-400 text-lg">
            Upload your text or type directly to process your text (results saved to database).
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-gray-800/50 backdrop-blur-lg rounded-2xl p-6 md:p-8 shadow-xl border border-gray-700">
          {/* Input Section */}
          <div className="space-y-6">
            {/* Text Input */}
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-2 text-center">
                Text Input
              </label>
              <textarea
                className="w-full h-32 px-4 py-3 bg-gray-900/50 border border-gray-700 rounded-lg 
                          text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 
                          focus:ring-blue-500 focus:border-transparent transition duration-200"
                placeholder="Type or paste your text here..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={1024}
              />
              <p className="text-sm text-gray-500 mt-1 text-center">
                {text.length}/1024 characters
              </p>
            </div>

            {/* File Upload */}
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-2 text-center">
                Upload a .txt file
              </label>
              <div className="relative">
                <input
                  type="file"
                  accept=".txt"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="hidden"
                  id="file-upload"
                />
                <label
                  htmlFor="file-upload"
                  className="cursor-pointer flex items-center justify-center w-full px-4 py-3 
                           bg-gray-900/50 border-2 border-dashed border-gray-700 rounded-lg
                           hover:border-blue-500 transition duration-200"
                >
                  <div className="flex items-center space-x-2">
                    <svg
                      className="w-6 h-6 text-gray-400"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path d="M12 4v16m8-8H4" />
                    </svg>
                    <span className="text-gray-400">
                      {file ? file.name : 'Choose a file or drag it here'}
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* Process Button */}
            <button
              onClick={handleUpload}
              disabled={isLoading || (!text && !file)}
              className={`w-full py-3 px-4 rounded-lg font-medium transition duration-200
                        ${
                          isLoading || (!text && !file)
                            ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                            : 'bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white'
                        }`}
            >
              {isLoading ? (
                <div className="flex items-center justify-center space-x-2">
                  <div className="w-5 h-5 border-t-2 border-b-2 border-white rounded-full animate-spin" />
                  <span>Processing...</span>
                </div>
              ) : (
                'Process Text'
              )}
            </button>
          </div>

          {/* Success Message */}
          {showSuccess && (
            <div className="mt-6 p-4 bg-green-500/20 border border-green-500/50 rounded-lg">
              <p className="text-green-400 text-center">
                Processing started successfully! ID: {fileId}
              </p>
            </div>
          )}
        </div>
 
        {/* Footer */}
        <div className="mt-8 text-center space-y-2">
          <p className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500 font-medium">
            Created by Nathan French
          </p>
        </div>
      </div>
    </div>
  );
}
