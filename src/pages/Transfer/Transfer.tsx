import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { BrowserQRCodeReader } from '@zxing/browser';
import { Activity, CheckCircle2, Download, FileUp, Gauge, LockKeyhole, Radio, ScanLine, ShieldCheck, TimerReset, WifiOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { QrDecodePool } from '../../lib/qrDecodePool';
import { createBenchmarkStart, finishBenchmark, type BenchmarkSample, type OpticalBenchmark } from '../../lib/opticalBenchmark';
import { addTransferFrame, createTransfer, getTransferReceivedFrames, isTransferFrame, parseTransferFrame, reconstructTransfer, OR_TRANSFER_BYTES_PER_FRAME, OR_TRANSFER_DENSE_BYTES_PER_FRAME } from '../../lib/orTransfer';
import { createAckPayload, getAckMissingIndexes, parseAckPayload, setAckBit } from '../../lib/opticalControl';
import { createQrMatrices, drawQrMatricesToCanvas } from '../../lib/qrCanvas';
import { QrEncodePool, type QrEncodeResult } from '../../lib/qrEncodePool';
import { createFountainDecoder, createFountainTransfer, FOUNTAIN_BLOCK_BYTES, FOUNTAIN_GRID_SIZE, isFountainFrame, parseFountainFrame, type FountainDecoder, type FountainDroplet, type FountainPlan } from '../../lib/fountain';
import { addMultiImageChunk, isMultiImageQr, reconstructMultiImage } from '../../lib/imageQr';
import type { QrMatrix } from '../../lib/qrEncodePool';

type Result = { url:string; name:string; size:number; mime:string };
type Progress = { mode:'fountain'|'compatibility'|'multi-image'; session:string; name:string; received:number; total:number; duplicates:number };
type Telemetry = {
  startedAt:number|null;
  renderMs:number;
  encodeMs:number;
  prefetchReady:number;
  encoderWorkers:number;
  renderCount:number;
  renderFps:number;
  detectedPerSecond:number;
  solvedPerSecond:number;
  goodputKbps:number;
  duplicates:number;
  decodeMs:number;
  processMs:number;
  scanDelayMs:number;
  cameraFrames:number;
  decoderCalls:number;
  qrDetections:number;
  transferFrames:number;
  nativeCalls:number;
  nativeAssist:boolean;
  zxingCalls:number;
  zxingAssist:boolean;
  lastDetection:string;
};

type ZxingResult = { getText:()=>string };
type ZxingControls = { stop:()=>void };
type ZxingReader = {
  decodeFromVideoElement(
    source:HTMLVideoElement,
    callback:(result:ZxingResult|null,error?:unknown,controls?:ZxingControls)=>void,
  ):Promise<ZxingControls>;
  reset:()=>void;
  controls?:ZxingControls;
};

type NativeQrDetector = {
  detect(source:HTMLVideoElement):Promise<Array<{rawValue?:string;format?:string}>>;
};

type OpticalGuideState = {
  tone:'searching'|'closer'|'farther'|'center'|'steady'|'ready'|'light';
  title:string;
  detail:string;
  quality:number;
};

function getDisplayLaneCount() {
  if (typeof window === 'undefined') return 4;
  const width = Math.min(window.innerWidth, window.screen?.width || window.innerWidth);
  if (width < 640) return 1;
  if (width < 960) return 2;
  return 4;
}

export function Transfer() {
  const [tab,setTab]=useState<'send'|'receive'>('send');
  const [mode,setMode]=useState<'fountain'|'compatibility'>('fountain');
  const [transferDensity,setTransferDensity]=useState<'legacy'|'dense'>('dense');
  const [file,setFile]=useState<File|null>(null);
  const [fountain,setFountain]=useState<FountainPlan|null>(null);
  const [compat,setCompat]=useState<Awaited<ReturnType<typeof createTransfer>>|null>(null);
  const [group,setGroup]=useState(0);
  const [playing,setPlaying]=useState(false);
  // Reliability-first physical MVP: each compatibility QR is displayed long
  // enough for a slow camera to acquire it, and compatibility playback repeats it.
  const [intervalMs,setIntervalMs]=useState(35);
  // Protect the final compatibility frame with an explicit acquisition tail.
  const FINAL_FRAME_EXTRA_DWELLS=3;
  const [error,setError]=useState('');
  const [receiving,setReceiving]=useState(false);
  const [progress,setProgress]=useState<Progress|null>(null);
  const [result,setResult]=useState<Result|null>(null);
  const [autoTune,setAutoTune]=useState(true);
  const [showAdvanced,setShowAdvanced]=useState(false);
  const [benchmarking,setBenchmarking]=useState(false);
  const [benchmark,setBenchmark]=useState<OpticalBenchmark|null>(null);
  const [telemetry,setTelemetry]=useState<Telemetry>({startedAt:null,renderMs:0,encodeMs:0,prefetchReady:0,encoderWorkers:0,renderCount:0,renderFps:0,detectedPerSecond:0,solvedPerSecond:0,goodputKbps:0,duplicates:0,decodeMs:0,processMs:0,scanDelayMs:55,cameraFrames:0,decoderCalls:0,qrDetections:0,transferFrames:0,nativeCalls:0,nativeAssist:false,zxingCalls:0,zxingAssist:false,lastDetection:'—'});
  const [screenAwake,setScreenAwake]=useState(false);
  const [feedbackEnabled,setFeedbackEnabled]=useState(true);
  const [feedbackConnected,setFeedbackConnected]=useState(false);
  const [feedbackReceived,setFeedbackReceived]=useState(0);
  const [feedbackTotal,setFeedbackTotal]=useState(0);
  const [feedbackMissing,setFeedbackMissing]=useState<number[]>([]);
  const [feedbackState,setFeedbackState]=useState<'searching'|'connected'|'complete'|'unavailable'>('searching');
  const [feedbackLastAt,setFeedbackLastAt]=useState<number|null>(null);
  const [ackPayload,setAckPayload]=useState('');
  const inputRef=useRef<HTMLInputElement>(null);
  const videoRef=useRef<HTMLVideoElement>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const receivingRef=useRef(false);
  const fallbackCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const recoveryCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const qrPoolRef=useRef<QrDecodePool|null>(null);
  const playbackRafRef=useRef<number|null>(null);
  const playbackLastAtRef=useRef(0);
  const playbackGroupRef=useRef(0);
  const playbackRepeatRef=useRef(0);
  const playbackPlanKeyRef=useRef<string | null>(null);
  const playbackFountainRef=useRef(false);
  const playbackPrefetchRef=useRef<Set<string>>(new Set());
  const qrEncoderRef=useRef<QrEncodePool|null>(null);
  const qrCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const renderCacheRef=useRef<Map<string,{matrices:QrMatrix[];renderMs:number;encodeMs:number}>>(new Map());
  const renderEpochRef=useRef(0);
  const renderWindowStatsRef=useRef({started:0,count:0,renderMs:0});
  const fountainReadingRef=useRef<FountainDecoder|null>(null);
  const fountainMetaRef=useRef<FountainDroplet|null>(null);
  const compatibilitySessionRef=useRef<string|null>(null);
  const recentRef=useRef<Map<string,number>>(new Map());
  const renderCountRef=useRef(0);
  const renderWindowRef=useRef({started:0,count:0});
  const receiverStartedRef=useRef<number|null>(null);
  const detectedWindowRef=useRef({started:0,count:0});
  const solvedRef=useRef(0);
  const decodedBytesRef=useRef(0);
  const duplicateCountRef=useRef(0);
  const scanDelayRef=useRef(55);
  const cameraFramesRef=useRef(0);
  const decoderCallsRef=useRef(0);
  const qrDetectionsRef=useRef(0);
  const acceptedTransferFramesRef=useRef(0);
  const lastDetectionRef=useRef('—');
  const telemetryTickRef=useRef(0);
  const benchmarkStartedRef=useRef<number|null>(null);
  const benchmarkFramesRef=useRef(0);
  const benchmarkCodesRef=useRef(0);
  const benchmarkUniqueRef=useRef(new Set<string>());
  const benchmarkDecodeSamplesRef=useRef<number[]>([]);
  const benchmarkSamplesRef=useRef<BenchmarkSample[]>([]);
  const benchmarkTimerRef=useRef<number|null>(null);
  const wakeLockRef=useRef<WakeLockSentinel|null>(null);
  const fallbackLoopRef=useRef<number|null>(null);
  const fallbackActiveRef=useRef(false);
  const nativeLoopRef=useRef<number|null>(null);
  const nativeActiveRef=useRef(false);
  const nativeInFlightRef=useRef(false);
  const nativeDetectorRef=useRef<NativeQrDetector|null>(null);
  const nativeCallsRef=useRef(0);
  const zxingReaderRef=useRef<ZxingReader|null>(null);
  const zxingActiveRef=useRef(false);
  const zxingCallsRef=useRef(0);
  const [probeStatus,setProbeStatus]=useState('Not run');
  const [opticalGuide,setOpticalGuide]=useState<OpticalGuideState>({tone:'searching',title:'Looking for the sender screen…',detail:'Point your camera at the QR stream.',quality:0});
  const lastGuideBoxRef=useRef<{x:number;y:number;width:number;height:number}|null>(null);
  const guideStableCountRef=useRef(0);
  const decodeMaxDimensionRef=useRef(1120);
  const noDetectionDecodeCountRef=useRef(0);
  const feedbackVideoRef=useRef<HTMLVideoElement>(null);
  const feedbackStreamRef=useRef<MediaStream|null>(null);
  const feedbackReaderRef=useRef<ZxingReader|null>(null);
  const feedbackControlsRef=useRef<ZxingControls|null>(null);
  const feedbackPoolRef=useRef<QrDecodePool|null>(null);
  const feedbackCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const feedbackLoopRef=useRef<number|null>(null);
  const feedbackActiveRef=useRef(false);
  const feedbackLastAckSeqRef=useRef(-1);
  const feedbackConnectedRef=useRef(false);
  const feedbackLastAtRef=useRef<number|null>(null);
  const feedbackMissingSetRef=useRef(new Set<number>());
  const feedbackRetryIndexRef=useRef<number|null>(null);
  const feedbackRetryRepeatRef=useRef(0);
  const compatAckBitmapRef=useRef<Uint8Array|null>(null);
  const compatAckFirstMissingRef=useRef(1);
  const compatAckSessionRef=useRef<string|null>(null);
  const compatAckFrontierRef=useRef(0);
  const compatAckSequenceRef=useRef(0);
  const ackCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const ackPublishTimerRef=useRef<number|null>(null);
  const ackPendingPayloadRef=useRef<string|null>(null);
  const ackLastPublishedAtRef=useRef(0);
  const progressUiTickRef=useRef(0);
  const opticalCanvasSizeRef=useRef(900);
  const resultUrlRef=useRef<string|null>(null);

  function publishProgress(next:Progress){
    const now=performance.now();
    if(now-progressUiTickRef.current>=100 || next.received===next.total){
      progressUiTickRef.current=now;
      setProgress(next);
    }
  }

  function measureOpticalCanvasSize(canvas:HTMLCanvasElement){
    const cssWidth=Math.max(280,Math.floor(canvas.getBoundingClientRect().width || canvas.clientWidth || window.innerWidth));
    const dpr=Math.min(3,Math.max(1,window.devicePixelRatio||1));
    opticalCanvasSizeRef.current=Math.min(1800,Math.max(720,Math.round(cssWidth*dpr)));
  }

  function getOpticalCanvasSize(){
    return opticalCanvasSizeRef.current;
  }

  useEffect(()=>{
    const canvas=qrCanvasRef.current;
    if(!canvas)return;
    measureOpticalCanvasSize(canvas);
    if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(()=>measureOpticalCanvasSize(canvas));
    observer.observe(canvas);
    return()=>observer.disconnect();
  },[fountain,compat]);

  async function enterTransferFullscreen(){
    try{ await qrCanvasRef.current?.requestFullscreen?.(); }catch{}
  }

  useEffect(()=>{
    try{
      qrEncoderRef.current=new QrEncodePool();
      setTelemetry(prev=>({...prev,encoderWorkers:qrEncoderRef.current?.capacity ?? 0}));
    }catch{
      qrEncoderRef.current=null;
    }
    return()=>{
      qrEncoderRef.current?.dispose();
      qrEncoderRef.current=null;
    };
  },[]);

  useEffect(()=>{
    const previous=resultUrlRef.current;
    const next=result?.url ?? null;
    resultUrlRef.current=next;
    if(previous && previous!==next) URL.revokeObjectURL(previous);
  },[result]);

  useEffect(()=>()=>{
    stopReceive();
    stopPlayback();
    if(resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    void wakeLockRef.current?.release().catch(()=>{});
    wakeLockRef.current=null;
  },[]);

  useEffect(()=>{
    if(!ackPayload || !ackCanvasRef.current) return;
    try{drawQrMatricesToCanvas(ackCanvasRef.current,createQrMatrices([ackPayload]),280,12);}catch{}
  },[ackPayload]);

  async function setScreenWakeLock(active:boolean){
    if(!active){
      if(wakeLockRef.current){
        await wakeLockRef.current.release().catch(()=>{});
        wakeLockRef.current=null;
      }
      setScreenAwake(false);
      return;
    }
    if(!('wakeLock' in navigator)) return;
    try{
      if(!wakeLockRef.current || wakeLockRef.current.released){
        wakeLockRef.current=await navigator.wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release',()=>setScreenAwake(false),{once:true});
      }
      setScreenAwake(true);
    }catch{
      setScreenAwake(false);
    }
  }

  useEffect(()=>{
    if(!playing && !receiving) return;
    void setScreenWakeLock(true);
    const onVisibility=()=>{
      if(document.visibilityState==='visible' && (playing || receiving)){
        void setScreenWakeLock(true);
      }
    };
    document.addEventListener('visibilitychange',onVisibility);
    return()=>document.removeEventListener('visibilitychange',onVisibility);
  },[playing,receiving]);

  useEffect(()=>{
    if(!playing) return;

    playbackLastAtRef.current=0;
    const tick=(now:number)=>{
      if(playbackLastAtRef.current===0 || now-playbackLastAtRef.current>=intervalMs){
        playbackLastAtRef.current=now;

        // Keep playback on the animation-frame path. The QR canvas is painted
        // directly from the warmed cache, so React does not re-render the
        // entire transfer screen for every optical frame.
        const planKey=playbackPlanKeyRef.current;
        if(planKey){
          const fountainMode=playbackFountainRef.current;
          const plan=fountainMode ? fountain : compat;
          if(plan && qrCanvasRef.current){
            const displayLanes=getDisplayLaneCount();
    const grid=displayLanes === 1 ? 1 : displayLanes === 2 ? 2 : 4;
            const totalGroups=fountainMode
              ? Math.max(1,Math.ceil((plan as FountainPlan).recommended/grid))
              : Math.max(1,Math.ceil((plan as Awaited<ReturnType<typeof createTransfer>>).total/grid));
            const missingSet=feedbackMissingSetRef.current;
            if(!fountainMode && feedbackEnabled && feedbackConnected && feedbackRetryIndexRef.current===null && missingSet.size>0){
              const nextMissing=[...missingSet].filter(index=>index>=1 && index<=totalGroups).sort((a,b)=>a-b)[0];
              if(nextMissing!==undefined){
                feedbackRetryIndexRef.current=nextMissing;
                feedbackRetryRepeatRef.current=0;
              }
            }
            const retryIndex=!fountainMode && feedbackEnabled && feedbackConnected ? feedbackRetryIndexRef.current : null;
            const nextGroup=retryIndex!==null ? Math.floor((retryIndex-1)/grid) : (fountainMode ? playbackGroupRef.current : playbackGroupRef.current % totalGroups);
            const cacheKey=planKey+':'+nextGroup;
            const cached=renderCacheRef.current.get(cacheKey);
            if(cached) {
              drawQrMatricesToCanvas(qrCanvasRef.current,cached.matrices,getOpticalCanvasSize(),18);
              if(fountainMode){
                playbackGroupRef.current+=1;
              }else if(retryIndex!==null){
                feedbackRetryRepeatRef.current+=1;
                if(feedbackRetryRepeatRef.current>=2){
                  missingSet.delete(retryIndex);
                  feedbackRetryIndexRef.current=null;
                  feedbackRetryRepeatRef.current=0;
                  setFeedbackMissing([...missingSet].sort((a,b)=>a-b).slice(0,24));
                }
              }else{
                playbackRepeatRef.current+=1;
                const isLastCompatibilityGroup=playbackGroupRef.current>=totalGroups-1;
                // One acquisition dwell is enough for normal frames after the MVP proof.
                // The final frame keeps a protected tail because it is the most common
                // boundary-condition failure on slow cameras.
                const requiredRepeats=isLastCompatibilityGroup ? 1+FINAL_FRAME_EXTRA_DWELLS : 1;
                if(playbackRepeatRef.current>=requiredRepeats){
                  playbackRepeatRef.current=0;
                  playbackGroupRef.current+=1;
                }
              }
            } else if(!playbackPrefetchRef.current.has(cacheKey)) {
              playbackPrefetchRef.current.add(cacheKey);
              void buildRenderGroup(planKey,plan,nextGroup,fountainMode)
                .finally(()=>playbackPrefetchRef.current.delete(cacheKey))
                .catch(()=>{});
            }
          }
        }
      }
      playbackRafRef.current=window.requestAnimationFrame(tick);
    };

    playbackRafRef.current=window.requestAnimationFrame(tick);
    return()=>{
      if(playbackRafRef.current!==null){
        window.cancelAnimationFrame(playbackRafRef.current);
        playbackRafRef.current=null;
      }
      playbackLastAtRef.current=0;
    };
  },[playing,intervalMs,fountain,compat]);

  function clearRenderPipeline(){
    renderEpochRef.current+=1;
    renderCacheRef.current.clear();
    renderWindowStatsRef.current={started:0,count:0,renderMs:0};
    setTelemetry(prev=>({...prev,prefetchReady:0,encodeMs:0,renderMs:0,renderCount:0,renderFps:0}));
  }

  async function buildRenderGroup(
    planKey:string,
    plan:FountainPlan|Awaited<ReturnType<typeof createTransfer>>,
    groupIndex:number,
    fountainMode:boolean,
  ){
    const displayLanes=getDisplayLaneCount();
    const grid=displayLanes === 1 ? 1 : displayLanes === 2 ? 2 : 4;
    const totalGroups=fountainMode
      ? Math.max(1,Math.ceil((plan as FountainPlan).recommended/grid))
      : Math.max(1,Math.ceil((plan as Awaited<ReturnType<typeof createTransfer>>).total/grid));
    const current=fountainMode ? groupIndex : groupIndex%totalGroups;
    const key=planKey+':'+current;
    const cached=renderCacheRef.current.get(key);
    if(cached){
      renderCacheRef.current.delete(key);
      renderCacheRef.current.set(key,cached);
      return {...cached,cacheHit:true};
    }

    const renderStart=performance.now();
    const values:string[]=[];
    for(let lane=0;lane<grid;lane+=1){
      if(fountainMode) values.push(await (plan as FountainPlan).getDroplet(lane,groupIndex,grid as 1 | 2 | 4));
      else{
        const index=current*grid+lane+1;
        const compatPlan=plan as Awaited<ReturnType<typeof createTransfer>>;
        if(index<=compatPlan.total) values.push(await compatPlan.getFrame(index));
      }
    }

    const encoder=qrEncoderRef.current;
    let encodeStats:QrEncodeResult|null=null;
    let matrices:QrMatrix[];
    if(encoder && encoder.capacity>0){
      encodeStats=await encoder.encode(values);
      matrices=encodeStats.matrices;
    }else{
      matrices=createQrMatrices(values);
    }

    const renderMs=performance.now()-renderStart;
    const entry={matrices,renderMs,encodeMs:encodeStats?.encodeMs ?? 0};
    renderCacheRef.current.delete(key);
    renderCacheRef.current.set(key,entry);
    while(renderCacheRef.current.size>6){
      const oldest=renderCacheRef.current.keys().next().value as string|undefined;
      if(!oldest)break;
      renderCacheRef.current.delete(oldest);
    }
    return {...entry,cacheHit:false};
  }

  useEffect(()=>{
    let cancelled=false;
    const plan=fountain ?? compat;
    if(!plan){ clearRenderPipeline(); return; }

    const epoch=++renderEpochRef.current;
    const fountainMode=Boolean(fountain);
    const planKey=fountainMode
      ? 'f:'+(fountain as FountainPlan).session
      : 'c:'+(compat as Awaited<ReturnType<typeof createTransfer>>).session;
    playbackPlanKeyRef.current=planKey;
    playbackPrefetchRef.current.clear();
    playbackFountainRef.current=fountainMode;
    const startGroup=playbackGroupRef.current;
    const groupIndices=[startGroup,startGroup+1,startGroup+2,startGroup+3,startGroup+4,startGroup+5];

    const loadGroup=async(index:number,display=false)=>{
      try{
        const entry=await buildRenderGroup(planKey,plan,index,fountainMode);
        if(cancelled || epoch!==renderEpochRef.current)return;
        if(display){
          renderCountRef.current+=1;
          if(qrCanvasRef.current && !playing) drawQrMatricesToCanvas(qrCanvasRef.current,entry.matrices,getOpticalCanvasSize(),18);
          const now=performance.now();
          if(renderWindowStatsRef.current.started===0)renderWindowStatsRef.current.started=now;
          renderWindowStatsRef.current.count+=1;
          renderWindowStatsRef.current.renderMs+=entry.renderMs;
          const windowMs=now-renderWindowStatsRef.current.started;
          if(windowMs>=1500){
            const fps=renderWindowStatsRef.current.count/(windowMs/1000);
            const avgRender=renderWindowStatsRef.current.renderMs/Math.max(1,renderWindowStatsRef.current.count);
            if(autoTune){
              // Closed-loop optical governor. Compatibility mode accelerates
              // only with a fresh receiver ACK and no reported gaps; stale ACK
              // state or missing frames biases playback slower before recovery.
              if(feedbackEnabled && !fountainMode && feedbackConnectedRef.current){
                const ackAge=feedbackLastAtRef.current===null?Number.POSITIVE_INFINITY:Date.now()-feedbackLastAtRef.current;
                const gaps=feedbackMissingSetRef.current.size;
                if(gaps>0 || ackAge>1400){
                  if(intervalMs<1300)setIntervalMs(v=>Math.min(1300,v+50));
                }else if(ackAge<900 && avgRender<22 && fps>18 && intervalMs>35){
                  setIntervalMs(v=>Math.max(35,v-10));
                }
              }else if(fountainMode){
                if(avgRender<14 && fps>18 && intervalMs>35)setIntervalMs(v=>Math.max(35,v-5));
                else if(avgRender>55 && intervalMs<500)setIntervalMs(v=>Math.min(500,v+20));
              }
            }
            renderWindowStatsRef.current={started:now,count:0,renderMs:0};
          }

          const displayGrid=getDisplayLaneCount() === 1 ? 1 : getDisplayLaneCount() === 2 ? 2 : 4;
          const totalGroupsForUi=fountainMode
            ? Math.max(1,Math.ceil((plan as FountainPlan).recommended/displayGrid))
            : Math.max(1,Math.ceil((plan as Awaited<ReturnType<typeof createTransfer>>).total/displayGrid));
          const ready=groupIndices.filter(next=>{
            const resolved=fountainMode ? next : next%totalGroupsForUi;
            return renderCacheRef.current.has(planKey+':'+resolved);
          }).length;

          setTelemetry(prev=>({
            ...prev,
            renderMs:prev.renderMs===0?entry.renderMs:prev.renderMs*.75+entry.renderMs*.25,
            encodeMs:prev.encodeMs===0?entry.encodeMs:prev.encodeMs*.75+entry.encodeMs*.25,
            prefetchReady:Math.min(ready,6),
            encoderWorkers:qrEncoderRef.current?.capacity ?? 0,
            renderCount:renderCountRef.current,
            renderFps:prev.renderFps===0
              ? 1/Math.max(.001,entry.renderMs/1000)
              : prev.renderFps*.8+(1/Math.max(.001,entry.renderMs/1000))*.2,
          }));
        }
      }catch(error){
        if(!cancelled && epoch===renderEpochRef.current)setError(error instanceof Error?error.message:'Unable to render the transfer stream.');
      }
    };

    void loadGroup(group,true);
    for(const index of groupIndices.slice(1)) void loadGroup(index,false);
    return()=>{cancelled=true;};
  },[fountain,compat,autoTune]);

  async function startPlayback(){
    const plan=fountain ?? compat;
    if(!plan) return;

    setError('');
    resetFeedbackState();
    if(feedbackEnabled){
      void startFeedbackCamera();
    }
    playbackGroupRef.current=0;
    const fountainMode=Boolean(fountain);
    const planKey=fountainMode
      ? 'f:'+(fountain as FountainPlan).session
      : 'c:'+(compat as Awaited<ReturnType<typeof createTransfer>>).session;

    playbackPlanKeyRef.current=planKey;
    playbackFountainRef.current=fountainMode;
    playbackPrefetchRef.current.clear();

    try{
      const entry=await buildRenderGroup(planKey,plan,0,fountainMode);
      if(playbackPlanKeyRef.current!==planKey) return;
      if(qrCanvasRef.current) drawQrMatricesToCanvas(qrCanvasRef.current,entry.matrices,getOpticalCanvasSize(),18);
      playbackRepeatRef.current=0;
      setPlaying(true);
    }catch(error){
      setError(error instanceof Error?error.message:'Unable to start the optical stream.');
    }
  }

  function resetFeedbackState(){
    feedbackLastAckSeqRef.current=-1;
    feedbackConnectedRef.current=false;
    feedbackLastAtRef.current=null;
    feedbackMissingSetRef.current.clear();
    feedbackRetryIndexRef.current=null;
    feedbackRetryRepeatRef.current=0;
    setFeedbackConnected(false);
    setFeedbackReceived(0);
    setFeedbackTotal(0);
    setFeedbackMissing([]);
    setFeedbackState(feedbackEnabled ? 'searching' : 'unavailable');
    setFeedbackLastAt(null);
  }

  function applyFeedbackAck(value:string){
    const ack=parseAckPayload(value);
    const activePlan=compat ?? fountain;
    if(!ack || !activePlan || ack.sequence<=feedbackLastAckSeqRef.current || ack.session!==activePlan.session) return false;

    feedbackLastAckSeqRef.current=ack.sequence;
    feedbackConnectedRef.current=true;
    feedbackLastAtRef.current=Date.now();
    setFeedbackConnected(true);
    setFeedbackReceived(ack.received);
    setFeedbackTotal(ack.total);
    setFeedbackLastAt(feedbackLastAtRef.current);

    if(ack.mode==='compatibility' && compat && ack.total===compat.total){
      const missingSet=feedbackMissingSetRef.current;
      const missingInWindow=new Set(getAckMissingIndexes(ack));
      for(let offset=0;offset<ack.windowBits;offset+=1){
        const index=ack.base+offset;
        if(missingInWindow.has(index)) missingSet.add(index);
        else missingSet.delete(index);
      }
      const missing=[...missingSet].filter(index=>index>=1 && index<=ack.total).sort((a,b)=>a-b);
      setFeedbackMissing(missing.slice(0,24));
      if(ack.state==='complete'){
        missingSet.clear();
        setFeedbackMissing([]);
        setFeedbackState('complete');
        setPlaying(false);
        stopFeedbackCamera();
      }else{
        setFeedbackState('connected');
      }
    }else if(ack.mode==='fountain' && fountain){
      setFeedbackMissing([]);
      setFeedbackState(ack.state==='complete' ? 'complete' : 'connected');
      if(ack.state==='complete'){
        setPlaying(false);
        stopFeedbackCamera();
      }
    }
    return true;
  }

  async function startFeedbackCamera(){
    if(!feedbackEnabled || feedbackActiveRef.current || !(compat ?? fountain)) return;
    if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia){
      setFeedbackState('unavailable');
      return;
    }
    try{
      const stream=await navigator.mediaDevices.getUserMedia({
        video:{facingMode:{ideal:'user'},width:{ideal:1280,max:1920},height:{ideal:720,max:1080},frameRate:{ideal:20,max:30}},
        audio:false,
      });
      feedbackStreamRef.current=stream;
      feedbackActiveRef.current=true;
      setFeedbackState('searching');

      const video=feedbackVideoRef.current;
      if(!video) throw new Error('Feedback camera preview is unavailable.');
      video.srcObject=stream;
      await video.play();

      try{
        const reader=new BrowserQRCodeReader(undefined,{delayBetweenScanAttempts:70,delayBetweenScanSuccess:70}) as unknown as ZxingReader;
        feedbackReaderRef.current=reader;
        const controls=await reader.decodeFromVideoElement(video,(result)=>{
          if(!feedbackActiveRef.current || !result) return;
          const value=result.getText();
          if(value) applyFeedbackAck(value);
        });
        if(feedbackActiveRef.current){
          feedbackControlsRef.current=controls;
          reader.controls=controls;
          return;
        }
        try{controls.stop();}catch{}
      }catch{
        feedbackReaderRef.current=null;
        feedbackControlsRef.current=null;
      }

      const canvas=feedbackCanvasRef.current ?? document.createElement('canvas');
      feedbackCanvasRef.current=canvas;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      if(!ctx) throw new Error('Feedback decoder surface is unavailable.');
      feedbackPoolRef.current=feedbackPoolRef.current ?? new QrDecodePool(1);
      const loop=()=>{
        if(!feedbackActiveRef.current) return;
        if(!video.videoWidth || video.readyState<2 || !feedbackPoolRef.current){
          feedbackLoopRef.current=window.setTimeout(loop,350);
          return;
        }
        const max=720;
        const scale=Math.min(1,max/Math.max(video.videoWidth,video.videoHeight));
        const width=Math.max(1,Math.round(video.videoWidth*scale));
        const height=Math.max(1,Math.round(video.videoHeight*scale));
        canvas.width=width; canvas.height=height;
        ctx.imageSmoothingEnabled=false;
        ctx.drawImage(video,0,0,width,height);
        const image=ctx.getImageData(0,0,width,height);
        const job=feedbackPoolRef.current.available>=0 ? feedbackPoolRef.current.decode(image.data.buffer,width,height,1) : null;
        if(job) void job.then(decoded=>{
          for(const value of decoded.values){
            if(applyFeedbackAck(value)) break;
          }
        }).catch(()=>{});
        feedbackLoopRef.current=window.setTimeout(loop,350);
      };
      loop();
    }catch{
      feedbackActiveRef.current=false;
      feedbackStreamRef.current?.getTracks().forEach(track=>track.stop());
      feedbackStreamRef.current=null;
      setFeedbackState('unavailable');
    }
  }

  function stopFeedbackCamera(){
    feedbackActiveRef.current=false;
    if(feedbackLoopRef.current!==null){
      window.clearTimeout(feedbackLoopRef.current);
      feedbackLoopRef.current=null;
    }
    try{feedbackControlsRef.current?.stop();}catch{}
    try{feedbackReaderRef.current?.reset();}catch{}
    feedbackControlsRef.current=null;
    feedbackReaderRef.current=null;
    feedbackStreamRef.current?.getTracks().forEach(track=>track.stop());
    feedbackStreamRef.current=null;
    feedbackPoolRef.current?.terminate();
    feedbackPoolRef.current=null;
    if(feedbackVideoRef.current) feedbackVideoRef.current.srcObject=null;
  }

  function publishAckPayload(payload:string,urgent=false){
    const now=performance.now();
    if(urgent || now-ackLastPublishedAtRef.current>=240){
      if(ackPublishTimerRef.current!==null){
        window.clearTimeout(ackPublishTimerRef.current);
        ackPublishTimerRef.current=null;
      }
      ackPendingPayloadRef.current=null;
      ackLastPublishedAtRef.current=now;
      setAckPayload(payload);
      return;
    }

    ackPendingPayloadRef.current=payload;
    if(ackPublishTimerRef.current===null){
      const wait=Math.max(20,Math.ceil(240-(now-ackLastPublishedAtRef.current)));
      ackPublishTimerRef.current=window.setTimeout(()=>{
        ackPublishTimerRef.current=null;
        const pending=ackPendingPayloadRef.current;
        ackPendingPayloadRef.current=null;
        if(!pending)return;
        ackLastPublishedAtRef.current=performance.now();
        setAckPayload(pending);
      },wait);
    }
  }

  function publishCompatibilityAck(frame:NonNullable<ReturnType<typeof parseTransferFrame>>,received:number,complete:boolean){
    if(!frame || !frame.total) return;
    const requiredBytes=Math.ceil(frame.total/8);
    if(compatAckSessionRef.current!==frame.session || !compatAckBitmapRef.current || compatAckBitmapRef.current.length!==requiredBytes){
      compatAckSessionRef.current=frame.session;
      compatAckBitmapRef.current=new Uint8Array(requiredBytes);
      compatAckFrontierRef.current=0;
      compatAckSequenceRef.current=0;
      compatAckFirstMissingRef.current=1;
      void getTransferReceivedFrames(frame.session).then(indexes=>{
        const bitmap=compatAckBitmapRef.current;
        if(compatAckSessionRef.current!==frame.session || !bitmap) return;
        for(const index of indexes) {
          setAckBit(bitmap,index,true);
          compatAckFrontierRef.current=Math.max(compatAckFrontierRef.current,index);
        }
        while(compatAckFirstMissingRef.current<=frame.total){
          const index=compatAckFirstMissingRef.current;
          if(!Boolean(bitmap[(index-1)>>>3] & (1<<((index-1)&7)))) break;
          compatAckFirstMissingRef.current+=1;
        }
        publishCompatibilityAck(frame,received,complete);
      }).catch(()=>{});
      return;
    }
    setAckBit(compatAckBitmapRef.current,frame.index,true);
    compatAckFrontierRef.current=Math.max(compatAckFrontierRef.current,frame.index);
    while(compatAckFirstMissingRef.current<=frame.total){
      const index=compatAckFirstMissingRef.current;
      if(!Boolean(compatAckBitmapRef.current[(index-1)>>>3] & (1<<((index-1)&7)))) break;
      compatAckFirstMissingRef.current+=1;
    }
    compatAckSequenceRef.current+=1;
    const payload=createAckPayload({
      session:frame.session,
      mode:'compatibility',
      total:frame.total,
      received,
      frontier:compatAckFrontierRef.current,
      firstMissing:Math.min(frame.total,compatAckFirstMissingRef.current),
      bitmap:compatAckBitmapRef.current,
      sequence:compatAckSequenceRef.current,
      state:complete?'complete':'streaming',
    });
    publishAckPayload(payload,complete);
  }

  function publishFountainAck(frame:FountainDroplet,solved:number,complete:boolean){
    const bits=new Uint8Array(Math.ceil(Math.min(64,frame.blocks)/8));
    bits.fill(0xff);
    compatAckSequenceRef.current+=1;
    const payload=createAckPayload({
      session:frame.session,
      mode:'fountain',
      total:frame.blocks,
      received:solved,
      frontier:frame.blocks,
      firstMissing:1,
      bitmap:bits,
      sequence:compatAckSequenceRef.current,
      state:complete?'complete':'streaming',
    });
    publishAckPayload(payload,complete);
  }

  function stopPlayback(){
    setPlaying(false);
    stopFeedbackCamera();
    playbackGroupRef.current=0;
    playbackRepeatRef.current=0;
    void setScreenWakeLock(false);
    if(playbackRafRef.current!==null){
      window.cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current=null;
    }
    playbackLastAtRef.current=0;
  }
  function stopReceive(preserveAck=false){
    receivingRef.current=false;
    streamRef.current?.getTracks().forEach(t=>t.stop());
    streamRef.current=null;
    try{zxingReaderRef.current?.controls?.stop();}catch{}
    try{zxingReaderRef.current?.reset();}catch{}
    zxingReaderRef.current=null;
    zxingActiveRef.current=false;
    void setScreenWakeLock(false);
    qrPoolRef.current?.terminate();
    qrPoolRef.current=null;
    if(benchmarkTimerRef.current!==null){window.clearTimeout(benchmarkTimerRef.current);benchmarkTimerRef.current=null;}
    benchmarkStartedRef.current=null;
    setBenchmarking(false);
    if(fallbackLoopRef.current!==null){window.clearTimeout(fallbackLoopRef.current);fallbackLoopRef.current=null;}
    if(nativeLoopRef.current!==null){window.clearTimeout(nativeLoopRef.current);nativeLoopRef.current=null;}
    fallbackActiveRef.current=false;
    nativeActiveRef.current=false;
    nativeInFlightRef.current=false;
    nativeDetectorRef.current=null;
    setReceiving(false);
    if(ackPublishTimerRef.current!==null){
      window.clearTimeout(ackPublishTimerRef.current);
      ackPublishTimerRef.current=null;
    }
    ackPendingPayloadRef.current=null;
    ackLastPublishedAtRef.current=0;
    if(!preserveAck) setAckPayload('');
  }

  async function startZxingAssist(){
    if(!receivingRef.current || !videoRef.current)return false;
    try{
      const reader=new BrowserQRCodeReader(undefined,{delayBetweenScanAttempts:90,delayBetweenScanSuccess:90}) as unknown as ZxingReader;
      zxingReaderRef.current=reader;
      zxingActiveRef.current=true;
      zxingCallsRef.current=0;
      setTelemetry(prev=>({...prev,zxingAssist:true,zxingCalls:0}));

      const controls=await reader.decodeFromVideoElement(videoRef.current,(result)=>{
        if(!receivingRef.current || !zxingActiveRef.current)return;
        zxingCallsRef.current+=1;
        if(result){
          const value=result.getText();
          if(value){
            qrDetectionsRef.current+=1;
            lastDetectionRef.current=value.slice(0,48);
            noDetectionDecodeCountRef.current=0;
            decodeMaxDimensionRef.current=720;
            void processValue(value);
          }
        }
        setTelemetry(prev=>({...prev,qrDetections:qrDetectionsRef.current,transferFrames:acceptedTransferFramesRef.current,zxingCalls:zxingCallsRef.current,lastDetection:lastDetectionRef.current}));
      });

      if(!receivingRef.current || !zxingActiveRef.current){
        try{controls.stop();}catch{}
        return false;
      }
      (zxingReaderRef.current as ZxingReader & {controls?:ZxingControls}).controls=controls;
      return true;
    }catch(error){
      zxingReaderRef.current=null;
      zxingActiveRef.current=false;
      setTelemetry(prev=>({...prev,zxingAssist:false,zxingCalls:zxingCallsRef.current}));
      if(receivingRef.current && error instanceof Error && /video|canvas|decode|camera/i.test(error.message)){
        // ZXing is optional; deterministic jsQR acquisition remains active.
      }
      return false;
    }
  }
  async function startNativeQrAssist(){
    if(!receivingRef.current || !videoRef.current)return false;

    const detectorCtor=(window as Window & {
      BarcodeDetector?: new(options?:{formats?:string[]})=>NativeQrDetector;
    }).BarcodeDetector;
    if(typeof detectorCtor!=='function')return false;

    try{
      const staticApi=detectorCtor as unknown as {getSupportedFormats?:()=>Promise<string[]>};
      const supported=typeof staticApi.getSupportedFormats==='function'
        ? await staticApi.getSupportedFormats()
        : null;
      if(supported && !supported.includes('qr_code'))return false;
      nativeDetectorRef.current=new detectorCtor({formats:['qr_code']});
    }catch{
      nativeDetectorRef.current=null;
      return false;
    }

    nativeActiveRef.current=true;
    nativeCallsRef.current=0;
    setTelemetry(prev=>({...prev,nativeAssist:true,nativeCalls:0}));

    const loop=async()=>{
      if(!receivingRef.current || !nativeActiveRef.current || !videoRef.current || !nativeDetectorRef.current)return;

      const video=videoRef.current;
      if(!nativeInFlightRef.current && video.readyState>=2 && video.videoWidth>0){
        nativeInFlightRef.current=true;
        nativeCallsRef.current+=1;

        try{
          const found=await nativeDetectorRef.current.detect(video);
          const values=found.map(item=>item.rawValue).filter((value):value is string=>Boolean(value));

          if(values.length>0){
            qrDetectionsRef.current+=values.length;
            lastDetectionRef.current=values[0].slice(0,48);
            noDetectionDecodeCountRef.current=0;
            decodeMaxDimensionRef.current=1120;
            await Promise.all(values.map(value=>processValue(value)));
          }

          setTelemetry(prev=>({
            ...prev,
            qrDetections:qrDetectionsRef.current,
            transferFrames:acceptedTransferFramesRef.current,
            nativeCalls:nativeCallsRef.current,
            lastDetection:lastDetectionRef.current,
          }));
        }catch{
          // Optional accelerator only. Never tear down the deterministic jsQR path.
          nativeActiveRef.current=false;
          nativeDetectorRef.current=null;
          setTelemetry(prev=>({...prev,nativeAssist:false,nativeCalls:nativeCallsRef.current}));
        }finally{
          nativeInFlightRef.current=false;
        }
      }

      if(receivingRef.current && nativeActiveRef.current){
        nativeLoopRef.current=window.setTimeout(()=>void loop(),20);
      }
    };

    void loop();
    return true;
  }

  async function probeLiveCameraFrame(){
    const video=videoRef.current;
    if(!receivingRef.current || !video || video.readyState<2 || !video.videoWidth){
      setProbeStatus('Camera frame unavailable — start the receiver first.');
      return;
    }

    const started=performance.now();
    const sourceWidth=video.videoWidth;
    const sourceHeight=video.videoHeight;

    const fullCanvas=fallbackCanvasRef.current ?? document.createElement('canvas');
    fallbackCanvasRef.current=fullCanvas;
    const fullCtx=fullCanvas.getContext('2d',{willReadFrequently:true});

    const centerCanvas=recoveryCanvasRef.current ?? document.createElement('canvas');
    recoveryCanvasRef.current=centerCanvas;
    const centerCtx=centerCanvas.getContext('2d',{willReadFrequently:true});

    if(!fullCtx || !centerCtx){
      setProbeStatus('Probe failed: unable to create camera image surfaces.');
      return;
    }

    const maxDimension=720;
    const scale=Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight));
    const width=Math.max(1,Math.round(sourceWidth*scale));
    const height=Math.max(1,Math.round(sourceHeight*scale));

    fullCanvas.width=width;
    fullCanvas.height=height;
    fullCtx.imageSmoothingEnabled=true;
    fullCtx.imageSmoothingQuality='high';
    fullCtx.drawImage(video,0,0,width,height);
    const image=fullCtx.getImageData(0,0,width,height);
    const direct=jsQR(image.data,width,height,{inversionAttempts:'attemptBoth'})?.data;

    const cropSize=Math.min(sourceWidth,sourceHeight);
    const cropScale=Math.min(1,maxDimension/cropSize);
    const centerSize=Math.max(1,Math.round(cropSize*cropScale));
    centerCanvas.width=centerSize;
    centerCanvas.height=centerSize;
    centerCtx.imageSmoothingEnabled=false;
    const sx=Math.floor((sourceWidth-cropSize)/2);
    const sy=Math.floor((sourceHeight-cropSize)/2);
    centerCtx.drawImage(video,sx,sy,cropSize,cropSize,0,0,centerSize,centerSize);
    const centerImage=centerCtx.getImageData(0,0,centerSize,centerSize);
    const center=jsQR(centerImage.data,centerSize,centerSize,{inversionAttempts:'attemptBoth'})?.data;

    const ms=performance.now()-started;
    const details=`${sourceWidth}×${sourceHeight} → ${width}×${height} · full ${direct?'HIT':'MISS'} · center ${center?'HIT':'MISS'} · ${ms.toFixed(0)} ms`;
    setProbeStatus(details);

    const values=[direct,center].filter((value):value is string=>Boolean(value));
    const unique=[...new Set(values)];
    for(const value of unique)await processValue(value);

    if(unique.length>0){
      qrDetectionsRef.current+=unique.length;
      lastDetectionRef.current=unique[0].slice(0,48);
      setTelemetry(prev=>({...prev,qrDetections:qrDetectionsRef.current,transferFrames:acceptedTransferFramesRef.current,lastDetection:lastDetectionRef.current}));
    }
  }

  function updateOpticalGuide(boxes:Array<{x:number;y:number;width:number;height:number}>, frameWidth:number, frameHeight:number, detected:boolean){
    if(!receivingRef.current) return;

    if(!detected || boxes.length===0){
      guideStableCountRef.current=0;
      const misses=noDetectionDecodeCountRef.current;
      const searching=misses<5;
      setOpticalGuide({
        tone:searching?'searching':'closer',
        title:searching?"Point at the other device's screen":'Move a little closer',
        detail:searching
          ?'Keep the sender display inside the camera guide.'
          :'Make the QR stream large enough for the camera to resolve reliably.',
        quality:searching?12:Math.max(24,Math.min(42,misses*3)),
      });
      return;
    }

    const primary=boxes.reduce((best,box)=>box.width*box.height>best.width*best.height?box:best,boxes[0]);
    const cx=(primary.x+primary.width/2)/Math.max(1,frameWidth);
    const cy=(primary.y+primary.height/2)/Math.max(1,frameHeight);
    const size=Math.min(primary.width/Math.max(1,frameWidth),primary.height/Math.max(1,frameHeight));
    const centered=Math.abs(cx-.5)<.14 && Math.abs(cy-.5)<.14;
    const previous=lastGuideBoxRef.current;
    const movement=previous
      ? Math.hypot(
          (primary.x-previous.x)/Math.max(1,frameWidth),
          (primary.y-previous.y)/Math.max(1,frameHeight),
        )
      : 0;
    lastGuideBoxRef.current=primary;
    if(movement<.025) guideStableCountRef.current+=1;
    else guideStableCountRef.current=0;

    if(!centered){
      const horizontal=Math.abs(cx-.5);
      const vertical=Math.abs(cy-.5);
      let title='';
      if(horizontal>=vertical) title=cx<.5?'Move slightly right':'Move slightly left';
      else title=cy<.5?'Move slightly down':'Move slightly up';
      setOpticalGuide({
        tone:'center',
        title,
        detail:'Center the sender screen inside the guide.',
        quality:55,
      });
      return;
    }

    if(size<.20){
      setOpticalGuide({
        tone:'closer',
        title:'Move a little closer',
        detail:boxes.length>1
          ?`The ${boxes.length} QR regions are too small. Bring the phone closer.`
          :'The QR is too small for reliable camera decoding.',
        quality:42,
      });
      return;
    }

    if(size>.78){
      setOpticalGuide({
        tone:'farther',
        title:'Move a little farther away',
        detail:'Give the camera more room around the sender screen.',
        quality:48,
      });
      return;
    }

    if(movement>.07){
      setOpticalGuide({
        tone:'steady',
        title:'Hold still',
        detail:'QR detected. Keep the phone still while the frame is captured.',
        quality:72,
      });
      return;
    }

    if(guideStableCountRef.current>=3){
      setOpticalGuide({
        tone:'ready',
        title:'Perfect — hold still',
        detail:boxes.length>1
          ?`${boxes.length} QR lanes detected · signal is ready`
          :'Ready to receive.',
        quality:96,
      });
      return;
    }

    setOpticalGuide({
      tone:'steady',
      title:'Hold still',
      detail:boxes.length>1
        ?`${boxes.length} QR lanes detected · keep the sender screen in view`
        :'Code found · keep the other screen inside the guide.',
      quality:86,
    });
  }

  function resetReading(){
    fountainReadingRef.current=null;
    fountainMetaRef.current=null;
    compatibilitySessionRef.current=null;
    recentRef.current.clear();
  }

  useEffect(()=>{
    if(playing && feedbackEnabled && (compat ?? fountain)) void startFeedbackCamera();
    if(!feedbackEnabled) stopFeedbackCamera();
  },[playing,feedbackEnabled,compat,fountain]);

  async function choose(value?:File, density: 'legacy' | 'dense' = transferDensity){
    if(!value)return;
    setError(''); setResult(null); stopPlayback(); playbackGroupRef.current=0; setGroup(0); resetReading(); clearRenderPipeline(); receiverStartedRef.current=null; solvedRef.current=0; decodedBytesRef.current=0; duplicateCountRef.current=0; detectedWindowRef.current={started:0,count:0}; renderWindowRef.current={started:0,count:0};
    try{
      if(mode==='fountain'){
        const plan=await createFountainTransfer(value); setFountain(plan); setCompat(null);
      }else{
        const plan=await createTransfer(value,{bytesPerFrame:density==='dense'?OR_TRANSFER_DENSE_BYTES_PER_FRAME:OR_TRANSFER_BYTES_PER_FRAME}); setCompat(plan); setFountain(null);
      }
      setFile(value);
    }catch(e){setFile(null);setFountain(null);setCompat(null);setError(e instanceof Error?e.message:'Unable to prepare this file.');}
  }

  async function finishBenchmarkRun(){
    const started=benchmarkStartedRef.current;
    if(started===null)return;
    benchmarkSamplesRef.current.push({at:performance.now(),bytesRecovered:decodedBytesRef.current,codesObserved:benchmarkCodesRef.current});
    setBenchmark(finishBenchmark(started,benchmarkFramesRef.current,benchmarkCodesRef.current,benchmarkUniqueRef.current.size,benchmarkDecodeSamplesRef.current,decodedBytesRef.current,benchmarkSamplesRef.current));
    setBenchmarking(false);
    benchmarkStartedRef.current=null;
    if(benchmarkTimerRef.current!==null){window.clearTimeout(benchmarkTimerRef.current);benchmarkTimerRef.current=null;}
  }

  function recordBenchmark(codes:string[],decodeMs=0){
    if(!benchmarking)return;
    benchmarkFramesRef.current+=1;
    benchmarkCodesRef.current+=codes.length;
    for(const value of codes)benchmarkUniqueRef.current.add(value);
    const started=benchmarkStartedRef.current;
    if(started!==null){
      benchmarkSamplesRef.current.push({at:performance.now(),bytesRecovered:decodedBytesRef.current,codesObserved:benchmarkCodesRef.current});
      if(benchmarkSamplesRef.current.length>240)benchmarkSamplesRef.current.shift();
    }
    if(decodeMs>0)benchmarkDecodeSamplesRef.current.push(decodeMs);
  }

  function startBenchmark(){
    if(!receiving)return;
    if(benchmarkTimerRef.current!==null)window.clearTimeout(benchmarkTimerRef.current);
    benchmarkFramesRef.current=0;
    benchmarkCodesRef.current=0;
    benchmarkUniqueRef.current.clear();
    benchmarkDecodeSamplesRef.current=[];
    benchmarkSamplesRef.current=[];
    benchmarkStartedRef.current=createBenchmarkStart();
    setBenchmark(null);
    setBenchmarking(true);
    benchmarkTimerRef.current=window.setTimeout(()=>{ void finishBenchmarkRun(); },15000);
  }

  function acceptValue(value:string){
    const now=performance.now(), previous=recentRef.current.get(value);
    if(previous!==undefined && now-previous<250)return false;
    recentRef.current.set(value,now);
    if(recentRef.current.size>800){
      for(const [key,t] of recentRef.current) if(now-t>5000) recentRef.current.delete(key);
    }
    return true;
  }

  async function processValue(value:string){
    if(!acceptValue(value))return;
    if(isMultiImageQr(value)){
      const added=await addMultiImageChunk(value);
      if(!added)return;
      if(added.duplicate)duplicateCountRef.current+=1;
      publishProgress({mode:'multi-image',session:added.id,name:added.name,received:added.received,total:added.total,duplicates:duplicateCountRef.current});
      if(added.complete){
        const rebuilt=await reconstructMultiImage(added.id);
        if(rebuilt){
          if(benchmarking) await finishBenchmarkRun();
          setResult({url:rebuilt.url,name:rebuilt.name,size:rebuilt.size,mime:rebuilt.mime});
          setProgress(null);
          stopReceive();
        }
      }
      return;
    }
    if(isFountainFrame(value)){
      const frame=parseFountainFrame(value); if(!frame)return;
      const activeMeta=fountainMetaRef.current;
      const sessionChanged=Boolean(activeMeta && (
        activeMeta.session !== frame.session ||
        activeMeta.hash !== frame.hash ||
        activeMeta.blocks !== frame.blocks ||
        activeMeta.size !== frame.size
      ));
      if(!fountainReadingRef.current || sessionChanged){
        fountainMetaRef.current=frame;
        fountainReadingRef.current=createFountainDecoder(frame);
        solvedRef.current=0;
        decodedBytesRef.current=0;
        setProgress(null);
      }
      const d=fountainReadingRef.current.add(frame);
      if(d.duplicate)duplicateCountRef.current+=1;
      solvedRef.current=d.solved;
      decodedBytesRef.current=Math.min(frame.size,d.solved*frame.blockBytes);
      publishProgress({mode:'fountain',session:frame.session,name:frame.name,received:d.solved,total:frame.blocks,duplicates:duplicateCountRef.current});
      publishFountainAck(frame,d.solved,d.complete);
      if(d.complete){
        const rebuilt=await fountainReadingRef.current.reconstruct();
        if(rebuilt){
          if(benchmarking) await finishBenchmarkRun();
          const url=URL.createObjectURL(new Blob([rebuilt.bytes.buffer as ArrayBuffer],{type:frame.mime}));
          setResult({url,name:frame.name,size:frame.size,mime:frame.mime}); setProgress(null); stopReceive(true);
        }
      }
      return;
    }
    if(isTransferFrame(value)){
      const frame=parseTransferFrame(value); if(!frame)return;
      if(compatibilitySessionRef.current && compatibilitySessionRef.current !== frame.session){
        decodedBytesRef.current=0;
        setProgress(null);
      }
      compatibilitySessionRef.current=frame.session;
      const sessionAtStart=frame.session;
      const added=await addTransferFrame(frame);
      acceptedTransferFramesRef.current+=1;
      // A newer optical session can arrive while IndexedDB is committing this
      // frame. Do not let an older in-flight promise overwrite the new session's
      // progress or trigger reconstruction for the wrong transfer.
      if(compatibilitySessionRef.current!==sessionAtStart)return;
      if(added.duplicate)duplicateCountRef.current+=1;
      decodedBytesRef.current=Math.min(frame.size,Math.round((added.received/added.total)*frame.size));
      publishProgress({mode:'compatibility',session:frame.session,name:frame.name,received:added.received,total:added.total,duplicates:duplicateCountRef.current});
      publishCompatibilityAck(frame,added.received,added.complete);
      if(added.complete){
        const rebuilt=await reconstructTransfer(frame.session);
        if(compatibilitySessionRef.current!==sessionAtStart)return;
        if(rebuilt){if(benchmarking) await finishBenchmarkRun(); setResult({url:rebuilt.url,name:rebuilt.name,size:rebuilt.size,mime:rebuilt.mime});setProgress(null);stopReceive(true);}
      }
    }
  }

  async function consumeDetected(found:Array<{rawValue?:string}>,decodeMs:number){
    const values=found.map(item=>item.rawValue).filter((value):value is string=>Boolean(value));
    await Promise.all(values.map(value=>processValue(value)));
    recordBenchmark(values,decodeMs);
    return values.length;
  }

  function startFallbackReading(){
    if(!receivingRef.current || fallbackActiveRef.current || !videoRef.current) return;
    fallbackActiveRef.current=true;
    const canvas=fallbackCanvasRef.current ?? document.createElement('canvas');
    fallbackCanvasRef.current=canvas;
    const recoveryCanvas=recoveryCanvasRef.current ?? document.createElement('canvas');
    recoveryCanvasRef.current=recoveryCanvas;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const recoveryCtx=recoveryCanvas.getContext('2d',{willReadFrequently:true});
    if(!ctx || !recoveryCtx){ setError('Camera fallback decoder could not create an image surface.'); stopReceive(); return; }
    let pool:QrDecodePool;
    try{
      pool=qrPoolRef.current ?? new QrDecodePool();
      qrPoolRef.current=pool;
    }catch(error){
      fallbackActiveRef.current=false;
      setError(error instanceof Error ? `QR decoder worker unavailable: ${error.message}` : 'QR decoder worker unavailable.');
      stopReceive();
      return;
    }
    const loop=async()=>{
      if(!receivingRef.current || !fallbackActiveRef.current || !videoRef.current || !qrPoolRef.current) return;
      if(qrPoolRef.current.healthyCount===0){
        setError('All QR decoder workers failed to start. Restart the receiver and try again.');
        stopReceive();
        return;
      }
      const started=performance.now();
      const video=videoRef.current;
      const sourceWidth=video.videoWidth;
      const sourceHeight=video.videoHeight;
      cameraFramesRef.current+=1;
      const healthNow=performance.now();
      if(healthNow-telemetryTickRef.current>=400){
        telemetryTickRef.current=healthNow;
        const elapsed=Math.max(.001,(healthNow-(receiverStartedRef.current??healthNow))/1000);
        setTelemetry(prev=>({...prev,startedAt:receiverStartedRef.current,solvedPerSecond:solvedRef.current/elapsed,goodputKbps:(decodedBytesRef.current/1024)/elapsed,duplicates:duplicateCountRef.current,scanDelayMs:scanDelayRef.current,cameraFrames:cameraFramesRef.current,decoderCalls:decoderCallsRef.current,qrDetections:qrDetectionsRef.current,transferFrames:acceptedTransferFramesRef.current,lastDetection:lastDetectionRef.current}));
      }

      if(sourceWidth && sourceHeight){
        // Baseline: decode the complete camera image at a moderate resolution.
        // Missed parts: after repeated misses, every other sample is a centered square
        // crop. The sender renders a square QR, while many phone camera streams are
        // 16:9, so the crop concentrates pixels on the optical payload.
        const misses=noDetectionDecodeCountRef.current;
        // Compatibility MVP always displays one large centered square QR.
        // Decode that optical ROI first at 720px. The old 1120px full-frame
        // baseline made jsQR spend ~1.3s on a single acquisition on this phone.
        // A smaller centered ROI reduces pixel work while preserving the QR's
        // module resolution. Full-frame recovery is deliberately occasional.
        const useCenterRecovery=misses%4!==3;

        let image:ImageData;
        let width:number;
        let height:number;

        if(useCenterRecovery){
          const cropSize=Math.min(sourceWidth,sourceHeight);
          const target=720;
          const scale=Math.min(1,target/cropSize);
          width=Math.max(1,Math.round(cropSize*scale));
          height=width;
          if(recoveryCanvas.width!==width)recoveryCanvas.width=width;
          if(recoveryCanvas.height!==height)recoveryCanvas.height=height;
          // QR modules are hard-edged geometry. Do not blur them while
          // reducing the camera frame into the acquisition ROI.
          recoveryCtx.imageSmoothingEnabled=false;
          const sx=Math.floor((sourceWidth-cropSize)/2);
          const sy=Math.floor((sourceHeight-cropSize)/2);
          recoveryCtx.drawImage(video,sx,sy,cropSize,cropSize,0,0,width,height);
          image=recoveryCtx.getImageData(0,0,width,height);
        }else{
          // Keep occasional full-frame recovery bounded as well. This path
          // exists for alignment/off-center recovery, not as the hot path.
          const maxDimension=Math.min(720,decodeMaxDimensionRef.current);
          const scale=Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight));
          width=Math.max(1,Math.round(sourceWidth*scale));
          height=Math.max(1,Math.round(sourceHeight*scale));
          if(canvas.width!==width)canvas.width=width;
          if(canvas.height!==height)canvas.height=height;
          ctx.imageSmoothingEnabled=false;
          ctx.drawImage(video,0,0,width,height);
          image=ctx.getImageData(0,0,width,height);
        }

        // Do not serialize camera capture behind a slow QR decode. The single
        // MVP worker stays deterministic; skipped busy samples are retried on the
        // next camera tick rather than queueing stale frames.
        if(qrPoolRef.current.available<0){
          fallbackLoopRef.current=window.setTimeout(()=>void loop(),Math.max(18,Math.min(40,scanDelayRef.current)));
          return;
        }
        // Keep the normal acquisition job to ONE jsQR pass. Quadrant recovery
        // is a last-resort mode after sustained misses, not the default path.
        const decodeDepth=misses>=8 || cameraFramesRef.current%6===0 ? 1 : 0;
        const job=qrPoolRef.current.decode(image.data.buffer,width,height,decodeDepth);
        if(job){
          decoderCallsRef.current+=1;
          void job.then(async decoded=>{
            const processStarted=performance.now();
            qrDetectionsRef.current+=decoded.values.length;
            if(decoded.values.length>0){
              const guideBoxes=(decoded.boxes ?? []).map(box=>useCenterRecovery
                ? {
                    x:Math.floor((sourceWidth-Math.min(sourceWidth,sourceHeight))/2 + (box.x/Math.max(1,width))*Math.min(sourceWidth,sourceHeight)),
                    y:Math.floor((sourceHeight-Math.min(sourceWidth,sourceHeight))/2 + (box.y/Math.max(1,height))*Math.min(sourceWidth,sourceHeight)),
                    width:Math.max(1,Math.floor((box.width/Math.max(1,width))*Math.min(sourceWidth,sourceHeight))),
                    height:Math.max(1,Math.floor((box.height/Math.max(1,height))*Math.min(sourceWidth,sourceHeight))),
                  }
                : {
                    x:Math.floor((box.x/Math.max(1,width))*sourceWidth),
                    y:Math.floor((box.y/Math.max(1,height))*sourceHeight),
                    width:Math.max(1,Math.floor((box.width/Math.max(1,width))*sourceWidth)),
                    height:Math.max(1,Math.floor((box.height/Math.max(1,height))*sourceHeight)),
                  });
              updateOpticalGuide(guideBoxes,sourceWidth,sourceHeight,true);
            }else{
              updateOpticalGuide([],sourceWidth,sourceHeight,false);
            }
            if(decoded.values.length>0){
              lastDetectionRef.current=decoded.values[0].slice(0,48);
              noDetectionDecodeCountRef.current=0;
              decodeMaxDimensionRef.current=1120;
            }else{
              noDetectionDecodeCountRef.current+=1;
              if(noDetectionDecodeCountRef.current>=12){
                decodeMaxDimensionRef.current=720;
              }
            }

            await Promise.all(decoded.values.map(value=>processValue(value)));

            const processMs=performance.now()-processStarted;
            recordBenchmark(decoded.values,decoded.processingMs);
            const now=performance.now();
            if(receiverStartedRef.current===null)receiverStartedRef.current=started;
            if(detectedWindowRef.current.started===0)detectedWindowRef.current.started=now;
            detectedWindowRef.current.count+=decoded.values.length;
            const windowMs=now-detectedWindowRef.current.started;
            if(windowMs>=500){
              const elapsed=Math.max(.001,(now-(receiverStartedRef.current??now))/1000);
              setTelemetry(prev=>({...prev,startedAt:receiverStartedRef.current,detectedPerSecond:detectedWindowRef.current.count/(windowMs/1000),solvedPerSecond:solvedRef.current/elapsed,goodputKbps:(decodedBytesRef.current/1024)/elapsed,duplicates:duplicateCountRef.current,decodeMs:prev.decodeMs===0?decoded.processingMs:prev.decodeMs*.7+decoded.processingMs*.3,processMs:prev.processMs===0?processMs:prev.processMs*.7+processMs*.3,scanDelayMs:scanDelayRef.current,cameraFrames:cameraFramesRef.current,decoderCalls:decoderCallsRef.current,qrDetections:qrDetectionsRef.current,transferFrames:acceptedTransferFramesRef.current,lastDetection:lastDetectionRef.current}));
              detectedWindowRef.current={started:now,count:0};
            }

            // Adapt the capture cadence to actual decoder cost, but never let
            // the optical receiver collapse into a single slow serial loop.
            scanDelayRef.current=decoded.processingMs>150
              ?Math.min(70,Math.max(40,Math.round(decoded.processingMs*.28)))
              :decoded.processingMs>75
                ?Math.min(60,Math.max(35,Math.round(decoded.processingMs*.32)))
                :decoded.values.length>0
                  ?Math.max(16,scanDelayRef.current-4)
                  :Math.min(50,scanDelayRef.current+2);
          }).catch(e=>{
            if(receivingRef.current)setError(e instanceof Error?e.message:'QR decoder worker failed.');
          });
        }
      }

      if(receivingRef.current && fallbackActiveRef.current){
        // 30–60 ms capture cadence gives the camera
        // several acquisition opportunities during each displayed QR interval.
        fallbackLoopRef.current=window.setTimeout(()=>void loop(),Math.max(16,Math.min(50,scanDelayRef.current)));
      }
    };
    void loop();
  }

  async function startReceive(){
    setError('');setResult(null);setProgress(null);resetReading();
    compatAckBitmapRef.current=null;
    compatAckFrontierRef.current=0;
    compatAckFirstMissingRef.current=1;
    compatAckSessionRef.current=null;
    compatAckSequenceRef.current=0;
    lastGuideBoxRef.current=null;
    guideStableCountRef.current=0;
    setOpticalGuide({tone:'searching',title:'Looking for the sender screen…',detail:'Point your camera at the QR stream.',quality:0});
    setAckPayload('');
    receiverStartedRef.current=null;solvedRef.current=0;duplicateCountRef.current=0;
    detectedWindowRef.current={started:0,count:0};scanDelayRef.current=55;
    cameraFramesRef.current=0;decoderCallsRef.current=0;qrDetectionsRef.current=0;acceptedTransferFramesRef.current=0;lastDetectionRef.current='—';telemetryTickRef.current=0;
    decodeMaxDimensionRef.current=1120;
    noDetectionDecodeCountRef.current=0;
    nativeCallsRef.current=0;
    nativeInFlightRef.current=false;
    zxingCallsRef.current=0;
    zxingActiveRef.current=false;
    zxingReaderRef.current=null;
    fallbackActiveRef.current=false;
    nativeActiveRef.current=false;
    setProbeStatus('Not run');
    setTelemetry(prev=>({...prev,startedAt:null,detectedPerSecond:0,solvedPerSecond:0,goodputKbps:0,duplicates:0,decodeMs:0,processMs:0,scanDelayMs:55,cameraFrames:0,decoderCalls:0,qrDetections:0,transferFrames:0,nativeCalls:0,nativeAssist:false,zxingCalls:0,zxingAssist:false,lastDetection:'—'}));

    try{
      if(!window.isSecureContext){
        throw new Error('Camera access requires HTTPS. Open the GitHub Pages HTTPS address, not an HTTP copy.');
      }
      if(!navigator.mediaDevices?.getUserMedia){
        throw new Error('This browser does not expose camera access (getUserMedia). Use a current Chrome, Edge, Safari, or Firefox browser.');
      }
      const stream=await navigator.mediaDevices.getUserMedia({
        video:{
          facingMode:{ideal:'environment'},
          width:{ideal:1920,max:2560},
          height:{ideal:1080,max:1440},
          frameRate:{ideal:60,max:60},
        },
        audio:false,
      });
      streamRef.current=stream;receivingRef.current=true;setReceiving(true);
      void setScreenWakeLock(true);
      const videoTrack=stream.getVideoTracks()[0];
      if(!videoTrack){
        throw new Error('Camera permission succeeded, but no video track was returned.');
      }
      videoTrack.addEventListener('ended',()=>{
        if(!receivingRef.current)return;
        stopReceive();
        setError('The camera stream ended. Restart the receiver and keep the browser in the foreground.');
      },{once:true});
      fallbackCanvasRef.current=document.createElement('canvas');
      try{qrPoolRef.current=new QrDecodePool();}catch{qrPoolRef.current=null;}
      if(!videoRef.current) throw new Error('Camera preview is unavailable.');
      videoRef.current.srcObject=stream;
      await videoRef.current.play();
      if(videoRef.current.readyState<2 || videoRef.current.videoWidth===0){
        await new Promise<void>((resolve,reject)=>{
          const video=videoRef.current;
          if(!video){ reject(new Error('Camera preview is unavailable.')); return; }
          let settled=false;
          const finish=()=>{ if(settled)return; settled=true; cleanup(); resolve(); };
          const fail=()=>{ if(settled)return; settled=true; cleanup(); reject(new Error('Camera opened, but no video frames are available.')); };
          const cleanup=()=>{
            video.removeEventListener('loadedmetadata',finish);
            video.removeEventListener('canplay',finish);
            window.clearTimeout(timeout);
          };
          const timeout=window.setTimeout(fail,2500);
          video.addEventListener('loadedmetadata',finish,{once:true});
          video.addEventListener('canplay',finish,{once:true});
          if(video.readyState>=2 && video.videoWidth>0) finish();
        });
      }

      // MVP receiver path: start the deterministic camera-frame worker immediately.
      // ZXing/BarcodeDetector remain available in the codebase for later experiments,
      // but they must not gate the first working end-to-end transfer.
      try{
        const track=stream.getVideoTracks()[0];
        if(track?.applyConstraints){
          await track.applyConstraints({advanced:[{focusMode:'continuous'}]} as unknown as MediaTrackConstraints).catch(()=>{});
        }
      }catch{}
      const nativeStarted=await startNativeQrAssist();
      if(!nativeStarted){
        // Use the deterministic worker decoder only when the browser has no
        // native multi-QR detector. Running several full decoders at once
        // wastes CPU and steals time from the camera pipeline.
        await startZxingAssist();
        startFallbackReading();
      }
    }catch(e){
      stopReceive();
      setError(e instanceof Error?e.message:'Camera permission was denied.');
    }
  }

  return <section className="transfer-page mx-auto max-w-6xl py-8 sm:py-12">
    <Link to="/" className="text-xs font-semibold text-[var(--text-muted)]">Back home</Link>
    <div className="mt-5 overflow-hidden rounded-[32px] border border-cyan-300/15 bg-[var(--bg-elevated)] p-6 shadow-glass backdrop-blur-2xl sm:p-9">
      <div className="flex flex-wrap gap-2"><span className="inline-flex items-center gap-2 rounded-full border border-cyan-300/15 bg-cyan-300/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[.18em] text-cyan-200"><Radio size={14}/> Easy file sharing</span><span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300"><WifiOff size={14}/> Works without internet</span></div>
      <h1 className="mt-5 text-4xl font-black tracking-[-.045em] sm:text-6xl">Send files <span className="text-gradient">without internet.</span></h1>
      <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--text-muted)] sm:text-base">Choose a file on one device and show it on your screen. Use the other device to receive it. The app handles missed pieces and checks the finished file automatically.</p>
    </div>

    <div className="transfer-tabs mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-1">
      <button onClick={()=>{stopReceive();setTab('send')}} className={`rounded-xl px-4 py-3 text-sm font-bold ${tab==='send'?'bg-white text-slate-950':'text-[var(--text-muted)]'}`}><FileUp size={15} className="mr-2 inline"/>Send</button>
      <button onClick={()=>{stopPlayback();setTab('receive')}} className={`rounded-xl px-4 py-3 text-sm font-bold ${tab==='receive'?'bg-white text-slate-950':'text-[var(--text-muted)]'}`}><ScanLine size={15} className="mr-2 inline"/>Receive</button>
    </div>

    {tab==='send' ? <div className="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
      <div className="glass-panel rounded-[28px] p-5">
        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white/5 p-1">
          <button onClick={()=>{stopPlayback();setMode('fountain');setFountain(null);setCompat(null);setFile(null);}} className={`rounded-xl px-3 py-3 text-xs font-bold ${mode==='fountain'?'bg-cyan-300 text-slate-950':'text-[var(--text-muted)]'}`}>Faster sharing</button>
          <button onClick={()=>{stopPlayback();setMode('compatibility');setFountain(null);setCompat(null);setFile(null);}} className={`rounded-xl px-3 py-3 text-xs font-bold ${mode==='compatibility'?'bg-white text-slate-950':'text-[var(--text-muted)]'}`}>Simple sharing</button>
        </div>
        <input ref={inputRef} type="file" className="sr-only" onChange={e=>{void choose(e.target.files?.[0]);e.currentTarget.value='';}}/>
        <button onClick={()=>inputRef.current?.click()} className="mt-4 w-full rounded-[24px] border border-dashed border-cyan-300/30 bg-cyan-300/[.05] p-8 text-center"><FileUp className="mx-auto text-cyan-300" size={30}/><p className="mt-3 font-bold">Choose any file</p><p className="mt-1 text-xs text-[var(--text-muted)]">{mode==='fountain'?'Up to 512 MB · faster sharing':'Up to 512 MB · simple recovery'}</p></button>
        <button onClick={()=>{const bytes=new Uint8Array(1024*1024);for(let i=0;i<bytes.length;i+=1)bytes[i]=(i*73+(i%251)*29+(i>>>8))&255;void choose(new File([bytes],'opticode-1mb-benchmark.bin',{type:'application/octet-stream'}));}} className="mt-3 w-full rounded-2xl border border-cyan-300/15 bg-white/5 p-3 text-left"><p className="text-xs font-black text-cyan-200">Sharing speed test</p><p className="mt-1 text-[10px] leading-5 text-[var(--text-muted)]">A small test file to check how quickly your devices can share a file.</p></button>
        {file&&<div className="mt-4 rounded-2xl bg-white/5 p-4"><p className="truncate font-bold">{file.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{(file.size/1024/1024).toFixed(2)} MB · {mode==='fountain'?`${fountain?.blocks.toLocaleString()} source blocks`:`${compat?.total.toLocaleString()} QR frames · ${compat?.bytesPerFrame ?? OR_TRANSFER_BYTES_PER_FRAME} bytes/frame`}</p></div>}
        {mode==='compatibility'&&<label className="mt-3 block rounded-2xl bg-white/5 p-3 text-xs font-bold">Simple sharing density<select value={transferDensity} onChange={e=>{const next=e.target.value as 'legacy'|'dense';setTransferDensity(next);if(file){void choose(file,next);}}} className="mt-2 w-full rounded-lg bg-black/20 p-2 text-xs"><option value="dense">Faster</option><option value="legacy">More reliable</option></select><p className="mt-1 text-[10px] leading-4 font-normal text-[var(--text-muted)]">Choose Faster for speed or More reliable if the camera has trouble reading the code.</p></label>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-white/5 p-4"><Gauge size={18} className="text-cyan-300"/><p className="mt-2 text-sm font-bold">Fast sharing</p><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">The app automatically adjusts the display to help the other device read the code.</p></div>
          <div className="rounded-2xl bg-white/5 p-4"><ShieldCheck size={18} className="text-emerald-300"/><p className="mt-2 text-sm font-bold">File checked</p><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">The app checks the finished file before saying the transfer is complete.</p></div>
        </div>
      </div>
      <div className="glass-panel rounded-[28px] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-cyan-300">Sharing screen</p><p className="mt-1 text-sm text-[var(--text-muted)]">{fountain?'Fast sharing mode':compat?'Simple sharing compatibility stream':'Choose a file to begin'}</p></div>{(fountain||compat)&&<div className="flex gap-2"><button onClick={()=>{void enterTransferFullscreen();}} className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-xs font-black text-cyan-200">Fullscreen QR</button><button onClick={()=>{if(playing)stopPlayback();else void startPlayback();}} className="rounded-full bg-white px-4 py-2 text-xs font-black text-slate-950">{playing?'Pause':'Start sharing'}</button></div>}</div>
        {(fountain||compat)?<canvas ref={qrCanvasRef} width={900} height={900} aria-label="OptiTransfer QR stream" className="transfer-canvas mx-auto mt-5 aspect-square w-full max-w-[760px] min-h-[min(72vh,760px)] rounded-2xl bg-white p-1 sm:p-2" style={{imageRendering:'crisp-edges'}}/>:<div className="mt-5 grid aspect-square place-items-center rounded-2xl bg-black/20 text-sm text-[var(--text-muted)]">QR stream preview</div>}
        {(compat||fountain)&&<button type="button" onClick={()=>setShowAdvanced(value=>!value)} className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3 text-left text-xs font-bold text-[var(--text)]">{showAdvanced ? "Hide extra options" : "More options"}<span className="ml-2 text-[var(--text-muted)]">{showAdvanced ? "Less settings" : "Speed, feedback and other settings"}</span></button>}
        {showAdvanced&&<>
        {(compat||fountain)&&<div className="mt-4 rounded-2xl bg-white/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="text-xs font-black text-cyan-200">Other device</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{feedbackState==='connected'?'Connected · the other device is receiving':feedbackState==='complete'?'Transfer complete · file checked':feedbackState==='unavailable'?'Not connected · sharing can continue':'Waiting for the other device'}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">Adaptive: {autoTune?'ON · speed rises while ACKs stay healthy':'OFF · manual speed'}</p></div>
            <button onClick={()=>{const next=!feedbackEnabled;setFeedbackEnabled(next);if(!next)stopFeedbackCamera();else if(playing)void startFeedbackCamera();}} className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-[10px] font-black text-cyan-200">{feedbackEnabled?'Feedback ON':'Feedback OFF'}</button>
          </div>
          <div className="mt-3 grid grid-cols-[100px_1fr] gap-3">
            <video ref={feedbackVideoRef} muted playsInline className="h-[75px] w-[100px] rounded-xl bg-black object-cover"/>
            <div className="min-w-0">
              <p className="text-sm font-black">{feedbackConnected?feedbackReceived.toLocaleString()+' / '+feedbackTotal.toLocaleString():'— / —'} parts received</p>
              <p className="mt-1 text-[10px] text-[var(--text-muted)]">Last update: {feedbackLastAt?new Date(feedbackLastAt).toLocaleTimeString():'—'}</p>
              {feedbackMissing.length>0&&<p className="mt-1 truncate text-[10px] font-bold text-amber-300">Not received:{feedbackMissing.slice(0,8).join(', #')}{feedbackMissing.length>8?' …':''}</p>}
              <p className="mt-1 text-[10px] text-[var(--text-muted)]">{compat?'The app will retry parts that were missed.':'The app uses extra recovery information to handle missed parts.'}</p>
            </div>
          </div>
        </div>}
        {(fountain||compat)&&<div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="rounded-xl bg-white/5 p-3 text-xs font-bold">Automatic speed<select value={autoTune?'on':'off'} onChange={e=>setAutoTune(e.target.value==='on')} className="mt-2 w-full rounded-lg bg-black/20 p-2 text-xs"><option value="on">On</option><option value="off">Off</option></select></label><label className="rounded-xl bg-white/5 p-3 text-xs font-bold">Sharing speed<select value={intervalMs} onChange={e=>setIntervalMs(Number(e.target.value))} className="mt-2 w-full rounded-lg bg-black/20 p-2 text-xs"><option value="35">Extreme</option><option value="45">Very fast</option><option value="60">Fast</option><option value="80">Balanced</option><option value="120">Reliable</option><option value="180">Extra reliable</option></select></label><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Behind the scenes</b><p className="mt-1 text-[var(--text-muted)]">{telemetry.encoderWorkers>0?telemetry.encoderWorkers+' worker encoder':'main-thread fallback'} · {telemetry.prefetchReady}/6 groups ready</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Screen update</b><p className="mt-1 text-[var(--text-muted)]">{telemetry.renderMs.toFixed(1)} ms · QR encode {telemetry.encodeMs.toFixed(1)} ms</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>File per screen</b><p className="mt-1 text-[var(--text-muted)]">{fountain ? FOUNTAIN_BLOCK_BYTES + ' bytes/block' : (compat?.bytesPerFrame ?? OR_TRANSFER_BYTES_PER_FRAME) + ' raw bytes/frame · 1× dwell per frame'}</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Codes on screen</b><p className="mt-1 text-[var(--text-muted)]">{getDisplayLaneCount()} QR code{getDisplayLaneCount() === 1 ? "" : "s"} · The app chooses the screen layout automatically.</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Missed parts</b><p className="mt-1 text-[var(--text-muted)]">{fountain?'Extra recovery':'Simple sharing'}</p></div></div>}
        </>}
      </div>
    </div> : <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_.8fr]">
      <div className="transfer-camera glass-panel overflow-hidden rounded-[28px] p-4"><div className="relative overflow-hidden rounded-2xl bg-black"><video ref={videoRef} muted playsInline className="h-[min(72vh,720px)] min-h-[480px] w-full rounded-2xl bg-black object-contain sm:min-h-[560px]"/>{receiving&&<div className="pointer-events-none absolute inset-0"><div className="absolute inset-0 grid place-items-center"><div className={`relative aspect-square w-[72%] max-w-[560px] rounded-[28px] border-2 transition-colors duration-300 ${opticalGuide.tone==='ready'?'border-emerald-300 shadow-[0_0_32px_rgba(52,211,153,.28)]':opticalGuide.tone==='closer'||opticalGuide.tone==='farther'?'border-amber-300 shadow-[0_0_32px_rgba(251,191,36,.22)]':'border-cyan-300/70 shadow-[0_0_0_9999px_rgba(0,0,0,.18)]'}`}><span className="absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/75 px-3 py-1.5 text-[10px] font-black text-white">{opticalGuide.title}</span></div></div><div className="absolute bottom-4 left-1/2 w-[min(92%,440px)] -translate-x-1/2 rounded-2xl border border-white/15 bg-black/75 px-4 py-3 text-center text-white shadow-2xl backdrop-blur-md"><p className="text-[9px] font-black uppercase tracking-[.18em] text-cyan-200">OptiGuide</p><p aria-live="polite" className="mt-1 text-sm font-black">{opticalGuide.title}</p><p className="mt-1 text-[10px] leading-4 text-white/75">{opticalGuide.detail}</p><div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-cyan-300 transition-all duration-300" style={{width:opticalGuide.quality+'%'}}/></div></div></div>}{ackPayload&&<div className="pointer-events-none absolute bottom-3 right-3 rounded-2xl border border-cyan-300/40 bg-white/95 p-2 shadow-2xl"><p className="mb-1 text-center text-[9px] font-black text-slate-950">RECEIVING STATUS</p><canvas ref={ackCanvasRef} className="h-[180px] w-[180px] rounded-lg" aria-label="OptiTransfer receiver acknowledgement QR"/></div>}</div><div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>{if(receiving){setAckPayload('');stopReceive();}else void startReceive();}} className="rounded-full bg-white px-4 py-2 text-sm font-black text-slate-950">{receiving?'Stop receiver':'Start receiver'}</button><span className="rounded-full bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-300">{receiving?'Scanning':'Camera off'}</span>{receiving&&<button onClick={startBenchmark} className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-bold text-cyan-200">{benchmarking?'Benchmarking…':'Speed test'}</button>}</div></div>
      <div className="transfer-receiver-panel glass-panel rounded-[28px] p-5"><LockKeyhole size={20} className="text-cyan-300"/><p className="mt-3 font-bold">Easy receiving</p><p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">The receiver uses several ways to read the code so it can keep working when the camera misses a frame.</p><div className="mt-4 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.05] p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[.14em] text-cyan-200">OptiGuide</p><p className="mt-1 text-base font-black">{opticalGuide.title}</p><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{opticalGuide.detail}</p></div><div className="shrink-0 text-right"><p className="text-[10px] text-[var(--text-muted)]">Reading quality</p><p className="text-lg font-black">{opticalGuide.quality}%</p></div></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all duration-300" style={{width:opticalGuide.quality+'%'}}/></div><p className="mt-3 text-[10px] leading-4 text-[var(--text-muted)]">Follow the on-screen message. It will tell you when to move closer, move farther away, center the code, or hold still.</p></div><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-2xl bg-cyan-300/[.06] p-3"><Activity size={16} className="text-cyan-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Camera</p><p className="mt-1 text-sm font-black">{telemetry.cameraFrames}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">checks</p></div>
          <div className="rounded-2xl bg-cyan-300/[.06] p-3"><ScanLine size={16} className="text-cyan-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Code reads</p><p className="mt-1 text-sm font-black">{telemetry.qrDetections}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{telemetry.detectedPerSecond.toFixed(1)}/s</p></div>
          <div className="rounded-2xl bg-white/5 p-3"><TimerReset size={16} className="text-white/70"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Reading</p><p className="mt-1 text-sm font-black">{telemetry.decodeMs.toFixed(0)} ms</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{telemetry.decoderCalls} jsQR calls · {telemetry.zxingAssist?'ZXing QR assist':'jsQR worker fallback'}</p></div>
          <div className="rounded-2xl bg-white/5 p-3"><ShieldCheck size={16} className="text-emerald-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Parts received</p><p className="mt-1 text-sm font-black">{telemetry.transferFrames}</p><p className="mt-1 truncate text-[10px] text-[var(--text-muted)]">{telemetry.lastDetection}</p></div>
        </div>
        {receiving&&<div className="mt-3 rounded-2xl bg-white/5 p-3 text-[10px] leading-5 text-[var(--text-muted)]"><span className="font-bold text-white/80">Camera status:</span> {probeStatus === 'Not run' ? 'Ready' : probeStatus}</div>}
        {benchmark&&<div className="mt-5 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.05] p-4"><div className="flex items-center justify-between gap-2"><p className="text-xs font-bold uppercase tracking-[.14em] text-cyan-200">Physical 1 MB benchmark</p><span className="text-[10px] text-[var(--text-muted)]">{(benchmark.durationMs/1000).toFixed(1)} s</span></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><p className="text-[10px] text-[var(--text-muted)]">Sustained</p><p className="text-sm font-black">{benchmark.goodputKbps.toFixed(1)} KB/s</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Peak ≥1s</p><p className="text-sm font-black">{benchmark.peakGoodputKbps.toFixed(1)} KB/s</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Codes/sec</p><p className="text-sm font-black">{benchmark.sustainedDecodeRate.toFixed(1)} / {benchmark.peakDecodeRate.toFixed(1)}</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Unique codes</p><p className="text-sm font-black">{benchmark.uniqueCodes}</p></div></div><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl bg-white/5 p-3"><p className="text-[10px] text-[var(--text-muted)]">Decimen desktop→phone reference</p><p className="mt-1 text-xs font-bold">418.5 KB/s sustained · 601.5 KB/s peak</p></div><div className="rounded-xl bg-white/5 p-3"><p className="text-[10px] text-[var(--text-muted)]">Decimen phone→phone reference</p><p className="mt-1 text-xs font-bold">199.2 KB/s sustained · 340.8 KB/s peak</p></div></div><p className="mt-3 text-[10px] leading-5 text-[var(--text-muted)]">Run this on the actual device pair. The result is a measurement, not a simulated claim. To establish a “better than Decimen” result, repeat the same 1 MB, 10-second methodology on a comparable device pair and compare sustained and ≥1-second peak goodput.</p></div>}{progress&&<div className="mt-5 rounded-2xl bg-white/5 p-4"><p className="truncate text-sm font-bold">{progress.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{Math.min(100,Math.round(progress.received/Math.max(1,progress.total)*100))}% complete</p><div className="mt-3 h-2 rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all" style={{width:Math.min(100,Math.round(progress.received/progress.total*100)) + '%'}}/></div></div>}{result&&<div className="mt-5 rounded-2xl bg-emerald-400/10 p-4"><CheckCircle2 className="text-emerald-300"/><p className="mt-2 font-bold">File received and checked</p><p className="mt-1 truncate text-xs text-[var(--text-muted)]">{result.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{(result.size/1024/1024).toFixed(2)} MB · Ready to use</p>{result.mime.startsWith('image/')&&<img src={result.url} alt={result.name} className="mt-4 max-h-80 w-full rounded-xl object-contain bg-black/20" />}{result.mime==='application/pdf'&&<iframe src={result.url} title={result.name} className="mt-4 h-80 w-full rounded-xl bg-white" /> }<div className="mt-4 flex flex-wrap gap-2"><a href={result.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-cyan-300 px-4 py-2 text-sm font-bold text-slate-950">Open / View</a><a href={result.url} download={result.name} className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-950"><Download size={14}/> Save file</a></div></div>}{error&&<p className="mt-5 rounded-2xl bg-rose-400/10 p-4 text-sm text-rose-200">{error}</p>}</div>
    </div>}
    <div className="mt-5 grid gap-3 md:grid-cols-3">{[['01','Encode','The app prepares the file for sharing.'],['02','Stream','The file is shown on the screen for the other device to read.'],['03','Recover','If something is missed, the app automatically works around it and checks the finished file.']].map(([n,t,d])=><div key={n} className="glass-panel rounded-[24px] p-5"><span className="text-xs font-black text-cyan-300">{n}</span><h2 className="mt-2 font-bold">{t}</h2><p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">{d}</p></div>)}</div>
  </section>;
}
