
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  GoogleGenAI, 
  Modality, 
  Type, 
  GenerateContentResponse,
  LiveServerMessage
} from '@google/genai';
import { 
  Image as ImageIcon, 
  Video, 
  MessageSquare, 
  Mic, 
  MicOff, 
  Send, 
  Loader2, 
  Download, 
  Plus, 
  Settings,
  Sparkles,
  Info
} from 'lucide-react';

// --- Hilfsfunktionen für Audio (Live API) ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App = () => {
  const [activeTab, setActiveTab] = useState<'image' | 'video' | 'chat' | 'live'>('image');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Image State
  const [imagePrompt, setImagePrompt] = useState('');
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [aspectRatio, setAspectRatio] = useState<'1:1' | '16:9' | '9:16'>('1:1');

  // Video State
  const [videoPrompt, setVideoPrompt] = useState('');
  const [generatedVideo, setGeneratedVideo] = useState<string | null>(null);
  const [videoStatus, setVideoStatus] = useState('');

  // Chat State
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'model', text: string }[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Live State
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [transcriptions, setTranscriptions] = useState<string[]>([]);
  const liveSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, transcriptions]);

  // --- Image Generation ---
  const generateImage = async () => {
    if (!imagePrompt) return;
    setLoading(true);
    setError(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: imagePrompt }] },
        config: { imageConfig: { aspectRatio } }
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData);
      if (imagePart) {
        const url = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
        setGeneratedImages(prev => [url, ...prev]);
      } else {
        throw new Error("Kein Bild generiert.");
      }
    } catch (err: any) {
      setError(err.message || "Fehler bei der Bildgenerierung");
    } finally {
      setLoading(false);
    }
  };

  // --- Video Generation (Veo) ---
  const generateVideo = async () => {
    if (!videoPrompt) return;
    
    // Check for API Key
    const hasKey = await (window as any).aistudio.hasSelectedApiKey();
    if (!hasKey) {
      await (window as any).aistudio.openSelectKey();
      // Assume success as per instructions
    }

    setLoading(true);
    setError(null);
    setVideoStatus("Initialisiere Veo-Modell...");
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      let operation = await ai.models.generateVideos({
        model: 'veo-3.1-fast-generate-preview',
        prompt: videoPrompt,
        config: {
          numberOfVideos: 1,
          resolution: '720p',
          aspectRatio: '16:9'
        }
      });

      setVideoStatus("Das Video wird gerendert. Dies kann einige Augenblicke dauern...");
      
      while (!operation.done) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        setVideoStatus(prev => prev.includes("...") ? "Einen Moment Geduld, wir verfeinern die Details..." : "Das Video wird gerendert...");
        try {
          operation = await ai.operations.getVideosOperation({ operation: operation });
        } catch (opErr: any) {
          if (opErr.message.includes("Requested entity was not found")) {
            setVideoStatus("API-Key ungültig. Bitte erneut wählen.");
            await (window as any).aistudio.openSelectKey();
            throw new Error("Bitte versuchen Sie es erneut, nachdem Sie den Key ausgewählt haben.");
          }
          throw opErr;
        }
      }

      const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (downloadLink) {
        const resp = await fetch(`${downloadLink}&key=${process.env.API_KEY}`);
        const blob = await resp.blob();
        setGeneratedVideo(URL.createObjectURL(blob));
      }
    } catch (err: any) {
      setError(err.message || "Fehler bei der Videogenerierung");
    } finally {
      setLoading(false);
      setVideoStatus("");
    }
  };

  // --- Chat Logic ---
  const sendChatMessage = async () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: chatMessages.concat({ role: 'user', text: userMsg }).map(m => ({
          role: m.role,
          parts: [{ text: m.text }]
        }))
      });
      const text = response.text || "Keine Antwort erhalten.";
      setChatMessages(prev => [...prev, { role: 'model', text }]);
    } catch (err: any) {
      setError(err.message || "Chat-Fehler");
    } finally {
      setLoading(false);
    }
  };

  // --- Live Audio Logic ---
  const startLive = async () => {
    setIsLiveActive(true);
    setTranscriptions(["Verbindung wird aufgebaut..."]);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = outCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: "Du bist ein hilfreicher Assistent im Gemini Kreativ-Studio. Antworte immer auf Deutsch, sei freundlich und kreativ.",
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setTranscriptions(prev => [...prev, "Bereit zum Sprechen!"]);
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.outputTranscription) {
              setTranscriptions(prev => [...prev, "KI: " + msg.serverContent!.outputTranscription!.text]);
            }
            if (msg.serverContent?.inputTranscription) {
              setTranscriptions(prev => [...prev, "Du: " + msg.serverContent!.inputTranscription!.text]);
            }

            const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const buffer = await decodeAudioData(decode(base64Audio), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
              source.onended = () => audioSourcesRef.current.delete(source);
            }

            if (msg.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => s.stop());
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => setIsLiveActive(false),
          onerror: (e) => { console.error(e); setIsLiveActive(false); }
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message);
      setIsLiveActive(false);
    }
  };

  const stopLive = () => {
    if (liveSessionRef.current) liveSessionRef.current.close();
    setIsLiveActive(false);
  };

  return (
    <div className="flex h-screen bg-[#0a0a0c] text-slate-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-20 lg:w-64 bg-[#111114] border-r border-white/5 flex flex-col p-4">
        <div className="flex items-center gap-3 px-2 mb-10">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Sparkles className="text-white" size={24} />
          </div>
          <span className="hidden lg:block font-bold text-xl tracking-tight text-white">Gemini Studio</span>
        </div>

        <nav className="flex-1 space-y-2">
          {[
            { id: 'image', icon: ImageIcon, label: 'Bild-KI' },
            { id: 'video', icon: Video, label: 'Video-KI' },
            { id: 'chat', icon: MessageSquare, label: 'Assistent' },
            { id: 'live', icon: Mic, label: 'Live-Sprache' },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id as any)}
              className={`w-full flex items-center gap-4 p-3 rounded-xl transition-all duration-200 group ${
                activeTab === item.id 
                ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' 
                : 'hover:bg-white/5 text-slate-400 hover:text-white'
              }`}
            >
              <item.icon size={22} className={activeTab === item.id ? 'text-indigo-400' : 'group-hover:scale-110 transition-transform'} />
              <span className="hidden lg:block font-medium">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="mt-auto pt-4 border-t border-white/5">
          <button className="w-full flex items-center gap-4 p-3 rounded-xl text-slate-500 hover:bg-white/5 transition-colors">
            <Settings size={22} />
            <span className="hidden lg:block font-medium">Einstellungen</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header className="h-16 border-b border-white/5 flex items-center justify-between px-8 bg-[#0a0a0c]/80 backdrop-blur-md z-10">
          <h2 className="text-lg font-semibold text-white">
            {activeTab === 'image' && 'Kreative Bildgenerierung'}
            {activeTab === 'video' && 'Kreative Videoproduktion'}
            {activeTab === 'chat' && 'KI-Assistent'}
            {activeTab === 'live' && 'Echtzeit-Sprachinteraktion'}
          </h2>
          {loading && (
            <div className="flex items-center gap-2 text-indigo-400 animate-pulse">
              <Loader2 className="animate-spin" size={18} />
              <span className="text-sm font-medium">Verarbeitung...</span>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          {error && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 flex items-center gap-3">
              <Info size={18} />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* Tab Views */}
          {activeTab === 'image' && (
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="bg-[#111114] border border-white/5 rounded-2xl p-6 shadow-xl">
                <textarea
                  placeholder="Beschreiben Sie Ihr Traumbild (z.B. Eine futuristische Stadt bei Nacht in Neonfarben)..."
                  className="w-full bg-black/20 border border-white/10 rounded-xl p-4 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all resize-none text-white h-32"
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                />
                <div className="flex items-center justify-between mt-4">
                  <div className="flex gap-2">
                    {['1:1', '16:9', '9:16'].map((ratio) => (
                      <button
                        key={ratio}
                        onClick={() => setAspectRatio(ratio as any)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                          aspectRatio === ratio 
                          ? 'bg-indigo-500 text-white' 
                          : 'bg-white/5 text-slate-400 hover:bg-white/10'
                        }`}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={generateImage}
                    disabled={loading || !imagePrompt}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-xl font-semibold flex items-center gap-2 transition-all shadow-lg shadow-indigo-600/20"
                  >
                    {loading ? <Loader2 className="animate-spin" size={18} /> : <Plus size={18} />}
                    Generieren
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {generatedImages.map((src, idx) => (
                  <div key={idx} className="group relative bg-[#111114] border border-white/5 rounded-2xl overflow-hidden aspect-square shadow-2xl transition-transform hover:scale-[1.02]">
                    <img src={src} className="w-full h-full object-cover" alt="Generiertes Bild" />
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4">
                      <a href={src} download={`gemini-image-${idx}.png`} className="p-3 bg-white/10 hover:bg-white/20 rounded-full backdrop-blur-md transition-all text-white">
                        <Download size={24} />
                      </a>
                    </div>
                  </div>
                ))}
                {loading && !generatedImages.length && (
                  <div className="bg-[#111114] border border-white/5 rounded-2xl aspect-square flex flex-col items-center justify-center gap-4 animate-pulse">
                    <Loader2 className="animate-spin text-indigo-500" size={48} />
                    <p className="text-slate-500 font-medium">Bilderstellung läuft...</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'video' && (
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="bg-[#111114] border border-white/5 rounded-2xl p-6 shadow-xl">
                <textarea
                  placeholder="Beschreiben Sie eine Szene für Ihr Video (z.B. Ein Flug über einen glitzernden Ozean bei Sonnenuntergang)..."
                  className="w-full bg-black/20 border border-white/10 rounded-xl p-4 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all resize-none text-white h-32"
                  value={videoPrompt}
                  onChange={(e) => setVideoPrompt(e.target.value)}
                />
                <div className="flex items-center justify-between mt-4">
                  <p className="text-xs text-slate-500 max-w-xs italic">Hinweis: Video-Generierung kann bis zu 2 Minuten dauern.</p>
                  <button
                    onClick={generateVideo}
                    disabled={loading || !videoPrompt}
                    className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-xl font-semibold flex items-center gap-2 transition-all shadow-lg shadow-purple-600/20"
                  >
                    {loading ? <Loader2 className="animate-spin" size={18} /> : <Video size={18} />}
                    Video erstellen
                  </button>
                </div>
                {videoStatus && (
                  <div className="mt-4 p-3 bg-indigo-500/5 border border-indigo-500/20 rounded-lg flex items-center gap-3">
                    <Loader2 className="animate-spin text-indigo-500" size={16} />
                    <span className="text-xs text-indigo-400 font-medium">{videoStatus}</span>
                  </div>
                )}
              </div>

              {generatedVideo && (
                <div className="bg-[#111114] border border-white/5 rounded-2xl overflow-hidden shadow-2xl aspect-video relative group">
                  <video src={generatedVideo} controls className="w-full h-full object-cover" />
                  <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <a href={generatedVideo} download="gemini-video.mp4" className="p-3 bg-black/40 hover:bg-black/60 rounded-full backdrop-blur-md transition-all text-white flex items-center gap-2">
                      <Download size={20} />
                      <span className="text-sm font-semibold">Download</span>
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="max-w-3xl mx-auto h-[calc(100vh-200px)] flex flex-col">
              <div className="flex-1 space-y-6 mb-6">
                {chatMessages.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-40">
                    <MessageSquare size={64} className="mb-4" />
                    <h3 className="text-xl font-bold">Wie kann ich Ihnen helfen?</h3>
                    <p className="max-w-xs mt-2">Fragen Sie nach kreativen Ideen, Code oder Erklärungen.</p>
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm ${
                      msg.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-[#1a1a1e] border border-white/5 text-slate-200 rounded-tl-none'
                    }`}>
                      {msg.text}
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              <div className="relative group">
                <input
                  type="text"
                  placeholder="Schreiben Sie eine Nachricht..."
                  className="w-full bg-[#111114] border border-white/10 rounded-2xl py-4 pl-5 pr-14 focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-white shadow-xl"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                />
                <button
                  onClick={sendChatMessage}
                  disabled={loading || !chatInput}
                  className="absolute right-3 top-2.5 p-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl transition-all"
                >
                  <Send size={20} />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'live' && (
            <div className="max-w-2xl mx-auto flex flex-col h-[calc(100vh-200px)]">
              <div className="flex-1 bg-[#111114] border border-white/5 rounded-3xl p-8 flex flex-col items-center justify-center text-center relative overflow-hidden shadow-2xl">
                {/* Visualizer Effect */}
                {isLiveActive && (
                  <div className="absolute inset-0 flex items-center justify-center opacity-20 pointer-events-none">
                    <div className="w-64 h-64 bg-indigo-500 rounded-full blur-[100px] animate-pulse" />
                  </div>
                )}
                
                <div className={`w-32 h-32 rounded-full flex items-center justify-center mb-8 transition-all duration-500 ${
                  isLiveActive ? 'bg-red-500/20 text-red-500 scale-110 shadow-[0_0_50px_rgba(239,68,68,0.3)]' : 'bg-indigo-500/20 text-indigo-500'
                }`}>
                  {isLiveActive ? <Mic size={64} className="animate-pulse" /> : <MicOff size={64} />}
                </div>

                <h3 className="text-2xl font-bold mb-2">
                  {isLiveActive ? 'Live Gespräch aktiv' : 'Sprachmodus starten'}
                </h3>
                <p className="text-slate-400 mb-8 max-w-sm">
                  Nutzen Sie Ihre Stimme, um mit Gemini in Echtzeit zu interagieren. Ideal für Brainstorming und natürliche Unterhaltungen.
                </p>

                <button
                  onClick={isLiveActive ? stopLive : startLive}
                  className={`px-10 py-4 rounded-2xl font-bold text-lg transition-all shadow-xl ${
                    isLiveActive 
                    ? 'bg-red-600 hover:bg-red-500 text-white shadow-red-600/20' 
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20'
                  }`}
                >
                  {isLiveActive ? 'Gespräch beenden' : 'Jetzt sprechen'}
                </button>

                {/* Live Transcription Log */}
                <div className="mt-12 w-full max-h-48 overflow-y-auto space-y-2 text-left px-4 custom-scrollbar">
                  {transcriptions.map((t, idx) => (
                    <div key={idx} className="text-xs font-mono text-slate-500 border-l border-white/10 pl-3">
                      {t}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.1);
        }
      `}</style>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
