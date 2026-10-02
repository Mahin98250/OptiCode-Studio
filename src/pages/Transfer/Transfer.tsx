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
  detect(source:HTMLVideoElement):Promise<Array<{
    rawValue?:string;
    format?:string;
    boundingBox?:{x:number;y:number;width:number;height:number};
    cornerPoints?:Array<{x:number;y:number}>;
  }>>;
};

type OpticalGuideState = {
  tone:'searching'|'closer'|'farther'|'center'|'steady'|'ready'|'light';
  title:string;
  detail:string;
  quality:number;
};

type OpticalGuideRect = { left:number; top:number; width:number; height:number; };
type OpticalGuideBox = {
  x:number;
  y:number;
  width:number;
  height:number;
  corners?:Array<{x:number;y:number}>;
};

type OpticalGuideDiagnostics = {
  framing:'searching'|'good'|'off';
  distance:'unknown'|'too-far'|'good'|'too-close';
  lighting:'unknown'|'dark'|'good'|'glare';
  stability:'moving'|'steady'|'locked';
  geometry:'searching'|'good'|'tilted'|'cropped';
  focus:'unknown'|'good'|'soft';
};

type OpticalTrack = {
  box:{x:number;y:number;width:number;height:number};
  vx:number;
  vy:number;
  vw:number;
  vh:number;
  lastSeenAt:number;
  confidence:number;
  misses:number;
  confirmed:boolean;
};

function getDisplayLaneCount() {
  if (typeof window === 'undefined') return 1;

  // Physical camera tests work better when the sender dedicates the whole
  // surface to a single QR on touch devices. Multiple small QR regions reduce
  // finder-module size and make phone/tablet acquisition fragile.
  const touchDevice = navigator.maxTouchPoints > 0
    || window.matchMedia?.('(pointer: coarse)').matches === true;
  if (touchDevice) return 1;

  const width = Math.min(window.innerWidth, window.screen?.width || window.innerWidth);
  if (width < 1200) return 1;
  if (width < 1800) return 2;
  return 4;
}

export function Transfer() {
  const getRenderPrefetchWindow = () => {
    const workers = qrEncoderRef.current?.capacity ?? 0;
    const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4;
    const memory = typeof navigator === 'undefined'
      ? 4
      : (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;

    // Six groups is the reliability baseline. High-end devices get a deeper
    // render pipeline so encoding stays ahead of the optical display without
    // turning the cache into an unbounded memory sink.
    if (cores <= 2 || memory < 2 || workers <= 1) return 6;
    if (workers === 2 || cores <= 4 || memory < 4) return 9;
    return 12;
  };

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
  const fallbackUsesRvfcRef=useRef(false);
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
  const [opticalGuideRect,setOpticalGuideRect]=useState<OpticalGuideRect|null>(null);
  const [opticalGuideDiagnostics,setOpticalGuideDiagnostics]=useState<OpticalGuideDiagnostics>({framing:'searching',distance:'unknown',lighting:'unknown',stability:'moving',geometry:'searching',focus:'unknown'});
  const [opticalTrack,setOpticalTrack]=useState({confidence:0,predicted:false,ageMs:0});

  // Render the lock independently from decoder cadence. Decoders may deliver
  // geometry at 10–30 Hz, while the camera preview can be 30–60+ Hz. A
  // critically-damped spring makes the visual lock follow the latest target
  // continuously without the 100 ms CSS-transition "rubber band" lag.
  useEffect(()=>{
    if(!receiving){
      if(opticalVisualRafRef.current!==null){
        cancelAnimationFrame(opticalVisualRafRef.current);
        opticalVisualRafRef.current=null;
      }
      opticalVisualTargetRef.current=null;
      opticalVisualCurrentRef.current=null;
      opticalVisualVelocityRef.current={left:0,top:0,width:0,height:0};
      opticalVisualQuadTargetRef.current=null;
      opticalVisualQuadCurrentRef.current=null;
      opticalVisualQuadVelocityRef.current=[];
      opticalGuideVisibleRef.current=false;
      setOpticalGuideRect(null);
      return;
    }

    let last=performance.now();
    const tick=(time:number)=>{
      const target=opticalVisualTargetRef.current;
      const current=opticalVisualCurrentRef.current;
      if(target){
        const base=current ?? target;
        const next={...base};
        const velocity=opticalVisualVelocityRef.current;
        const dt=Math.min(.034,Math.max(.008,(time-last)/1000));
        last=time;
        // Exact critically-damped second-order integration. Unlike a CSS
        // transition, this is frame-rate independent, never overshoots, and
        // keeps the overlay glued to the latest detector target while the
        // decoder itself may only refresh at 10–30 Hz.
        // Raise spring response during larger target motion, then settle
        // smoothly for small corrections. This reduces visible tracking lag
        // without making a stationary lock jitter.
        const targetMotion=Math.hypot(target.left-base.left,target.top-base.top);
        const omega=targetMotion>3?44:targetMotion>1?36:30;
        (['left','top','width','height'] as const).forEach(key=>{
          const displacement=base[key]-target[key];
          const v=velocity[key];
          const e=Math.exp(-omega*dt);
          next[key]=target[key]+(displacement+(v+omega*displacement)*dt)*e;
          velocity[key]=(v-omega*(v+omega*displacement)*dt)*e;
        });
        opticalVisualCurrentRef.current=next;
        const overlay=opticalGuideOverlayRef.current;
        if(overlay){
          overlay.style.left=next.left+'%';
          overlay.style.top=next.top+'%';
          overlay.style.width=next.width+'%';
          overlay.style.height=next.height+'%';
        }else{
          setOpticalGuideRect(next);
        }

        const targetQuad=opticalVisualQuadTargetRef.current;
        const currentQuad=opticalVisualQuadCurrentRef.current;
        const polygon=opticalGuidePolygonRef.current;
        if(targetQuad && targetQuad.length===4){
          const quad=currentQuad ?? targetQuad;
          const velocities=opticalVisualQuadVelocityRef.current;
          while(velocities.length<4)velocities.push({x:0,y:0});
          const nextQuad=quad.map((point,index)=>{
            const targetPoint=targetQuad[index];
            const displacementX=point.x-targetPoint.x;
            const displacementY=point.y-targetPoint.y;
            const vx=velocities[index].x;
            const vy=velocities[index].y;
            const e=Math.exp(-omega*dt);
            const nextPoint={
              x:targetPoint.x+(displacementX+(vx+omega*displacementX)*dt)*e,
              y:targetPoint.y+(displacementY+(vy+omega*displacementY)*dt)*e,
            };
            velocities[index]={
              x:(vx-omega*(vx+omega*displacementX)*dt)*e,
              y:(vy-omega*(vy+omega*displacementY)*dt)*e,
            };
            return nextPoint;
          });
          opticalVisualQuadCurrentRef.current=nextQuad;
          if(polygon){
            polygon.setAttribute('points',nextQuad.map(point=>`${point.x},${point.y}`).join(' '));
            polygon.style.opacity='1';
          }
        }else if(polygon){
          polygon.style.opacity='0';
        }
      }
      opticalVisualRafRef.current=requestAnimationFrame(tick);
    };
    opticalVisualRafRef.current=requestAnimationFrame(tick);
    return()=>{
      if(opticalVisualRafRef.current!==null){
        cancelAnimationFrame(opticalVisualRafRef.current);
        opticalVisualRafRef.current=null;
      }
    };
  },[receiving]);
  const opticalTrackRef=useRef<OpticalTrack|null>(null);
  const lastGuideBoxRef=useRef<{x:number;y:number;width:number;height:number}|null>(null);
  const guideStableCountRef=useRef(0);
  const guideDetectionStreakRef=useRef(0);
  const guideDistanceRef=useRef<OpticalGuideDiagnostics['distance']>('unknown');
  const guideLightingRef=useRef<OpticalGuideDiagnostics['lighting']>('unknown');
  const guideFocusRef=useRef<OpticalGuideDiagnostics['focus']>('unknown');
  const guideMissStreakRef=useRef(0);
  const opticalVisualTargetRef=useRef<OpticalGuideRect|null>(null);
  const opticalVisualCurrentRef=useRef<OpticalGuideRect|null>(null);
  const opticalVisualVelocityRef=useRef({left:0,top:0,width:0,height:0});
  const opticalVisualRafRef=useRef<number|null>(null);
  const opticalGuideOverlayRef=useRef<HTMLDivElement|null>(null);
  const opticalGuidePolygonRef=useRef<SVGPolygonElement|null>(null);
  const opticalGuideVisibleRef=useRef(false);
  const opticalVisualQuadTargetRef=useRef<Array<{x:number;y:number}>|null>(null);
  const opticalVisualQuadCurrentRef=useRef<Array<{x:number;y:number}>|null>(null);
  const opticalVisualQuadVelocityRef=useRef<Array<{x:number;y:number}>>([]);
  const opticalGroupBoxRef=useRef<{x:number;y:number;width:number;height:number}|null>(null);
  const opticalGroupVelocityRef=useRef({x:0,y:0,width:0,height:0});
  const opticalGroupLastSeenRef=useRef(0);
  const decodeMaxDimensionRef=useRef(1120);
  const noDetectionDecodeCountRef=useRef(0);
  // Parallel workers can finish out of order. Geometry must be monotonic in
  // capture sequence or an older frame can visibly pull the lock backwards.
  const opticalDecodeSequenceRef=useRef(0);
  const opticalLatestGeometrySequenceRef=useRef(0);
  const opticalAssociationBreakStreakRef=useRef(0);
  // Adaptive decode concurrency prevents a slow phone from filling every
  // worker with stale frames, while high-end devices can ramp up to the full
  // worker pool once actual decode latency proves they can sustain it.
  const decodeParallelismRef=useRef(1);
  const decodePerfWindowRef=useRef({samples:0,totalMs:0});
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
  const fountainFeedbackRateRef=useRef({at:0,received:0});
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
    const cacheLimit=Math.max(8,getRenderPrefetchWindow()+2);
    while(renderCacheRef.current.size>cacheLimit){
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
    const prefetchWindow=getRenderPrefetchWindow();
    const groupIndices=Array.from({length:prefetchWindow},(_,offset)=>startGroup+offset);

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
                }else if(ackAge<900 && avgRender<22 && fps>18 && intervalMs>16){
                  setIntervalMs(v=>Math.max(16,v-10));
                }
              }else if(fountainMode && !(feedbackEnabled && feedbackConnectedRef.current)){
                if(avgRender<14 && fps>18 && intervalMs>16)setIntervalMs(v=>Math.max(16,v-5));
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
            prefetchReady:Math.min(ready,prefetchWindow),
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
    fountainFeedbackRateRef.current={at:0,received:0};
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
    const expectedMode=compat ? 'compatibility' : fountain ? 'fountain' : null;
    const expectedTotal=compat?.total ?? fountain?.blocks ?? 0;
    // Validate the full transfer identity before allowing an ACK to affect
    // link state, retransmission, or the adaptive speed governor.
    if(
      !ack ||
      !activePlan ||
      ack.sequence<=feedbackLastAckSeqRef.current ||
      ack.session!==activePlan.session ||
      ack.mode!==expectedMode ||
      ack.total!==expectedTotal
    ) return false;

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

      // Receiver-driven fountain governor. Render FPS alone cannot tell us if
      // the phone camera is actually keeping up. The receiver reports solved
      // source blocks, so estimate physical optical goodput from ACK deltas and
      // push the sender toward the highest rate the current device pair can
      // sustain. This is the control loop that turns a fixed QR slideshow into
      // an adaptive optical transport.
      if(autoTune && feedbackEnabled && feedbackConnectedRef.current){
        const now=Date.now();
        const rateState=fountainFeedbackRateRef.current;
        if(rateState.at>0){
          const deltaSolved=Math.max(0,ack.received-rateState.received);
          const deltaMs=Math.max(1,now-rateState.at);
          const solvedPerSecond=deltaSolved/(deltaMs/1000);
          if(solvedPerSecond>=8 && deltaMs>=180){
            setIntervalMs(value=>Math.max(16,value-4));
          }else if(solvedPerSecond<2 && deltaMs>=500){
            setIntervalMs(value=>Math.min(1000,value+18));
          }
        }
        fountainFeedbackRateRef.current={at:now,received:ack.received};
      }

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
    if(fallbackLoopRef.current!==null){
      const video=videoRef.current as (HTMLVideoElement & {cancelVideoFrameCallback?:(handle:number)=>void}) | null;
      if(fallbackUsesRvfcRef.current) video?.cancelVideoFrameCallback?.(fallbackLoopRef.current);
      window.clearTimeout(fallbackLoopRef.current);
      fallbackLoopRef.current=null;
    }
    fallbackUsesRvfcRef.current=false;
    if(nativeLoopRef.current!==null){window.clearTimeout(nativeLoopRef.current);nativeLoopRef.current=null;}
    fallbackActiveRef.current=false;
    fallbackUsesRvfcRef.current=false;
    nativeActiveRef.current=false;
    nativeInFlightRef.current=false;
    nativeDetectorRef.current=null;
    opticalTrackRef.current=null;
    lastGuideBoxRef.current=null;
    guideStableCountRef.current=0;
    guideDistanceRef.current='unknown';
    guideDetectionStreakRef.current=0;
    guideMissStreakRef.current=0;
    guideDistanceRef.current='unknown';
    guideDetectionStreakRef.current=0;
    guideMissStreakRef.current=0;
    setOpticalTrack({confidence:0,predicted:false,ageMs:0});
    setOpticalGuideRect(null);
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
          const nativeBoxes=found.flatMap(item=>{
            if(!item.boundingBox)return [];
            return [{
              ...item.boundingBox,
              corners:item.cornerPoints?.filter(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)),
            } satisfies OpticalGuideBox];
          });

          // BarcodeDetector can publish geometry before the deterministic
          // worker finishes decoding the payload. Use that geometry only when
          // the worker has not refreshed the tracker very recently; this makes
          // the visual square feel immediate without letting two decoders fight
          // over the lock position.
          const workerTrack=opticalTrackRef.current;
          const workerTrackFresh=workerTrack ? performance.now()-workerTrack.lastSeenAt<180 : false;
          if(nativeBoxes.length>0 && !workerTrackFresh && video.videoWidth>0 && video.videoHeight>0){
            const metricsCanvas=recoveryCanvasRef.current ?? document.createElement('canvas');
            recoveryCanvasRef.current=metricsCanvas;
            const metricsCtx=metricsCanvas.getContext('2d',{willReadFrequently:true});
            if(metricsCtx){
              const sample=Math.min(360,Math.min(video.videoWidth,video.videoHeight));
              metricsCanvas.width=sample;
              metricsCanvas.height=sample;
              metricsCtx.imageSmoothingEnabled=false;
              const sx=Math.max(0,Math.floor((video.videoWidth-sample)/2));
              const sy=Math.max(0,Math.floor((video.videoHeight-sample)/2));
              metricsCtx.drawImage(video,sx,sy,sample,sample,0,0,sample,sample);
              updateOpticalGuide(nativeBoxes,video.videoWidth,video.videoHeight,true,estimateOpticalFrameMetrics(metricsCtx.getImageData(0,0,sample,sample)));
            }else{
              updateOpticalGuide(nativeBoxes,video.videoWidth,video.videoHeight,true);
            }
          }

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

  type OpticalFrameMetrics = {
    brightness:number;
    contrast:number;
    edgeEnergy:number;
    clippedHighlights:number;
    sharpness:number;
    sampledPixels:number;
  };

  function updateOpticalGuide(
    boxes:OpticalGuideBox[],
    frameWidth:number,
    frameHeight:number,
    detected:boolean,
    metrics?:OpticalFrameMetrics,
  ){
    if(!receivingRef.current) return;

    const now=performance.now();
    // Missing pixel metrics are unknown, not evidence of good lighting/focus.
    const metricsKnown=Boolean(metrics);
    const brightness=metrics?.brightness ?? Number.NaN;
    const contrast=metrics?.contrast ?? Number.NaN;
    const edgeEnergy=metrics?.edgeEnergy ?? Number.NaN;
    const clippedHighlights=metrics?.clippedHighlights ?? Number.NaN;
    const sharpness=metrics?.sharpness ?? Number.NaN;

    const classifyLighting=():OpticalGuideDiagnostics['lighting']=>{
      if(!metricsKnown) return 'unknown';
      const previous=guideLightingRef.current;
      if(previous==='dark' && brightness<45) return 'dark';
      if(previous==='glare' && clippedHighlights>.28 && contrast<40) return 'glare';
      if(brightness<36) return 'dark';
      if(clippedHighlights>.38 && contrast<32) return 'glare';
      return 'good';
    };

    const classifyFocus=():OpticalGuideDiagnostics['focus']=>{
      if(!metricsKnown) return 'unknown';
      const previous=guideFocusRef.current;
      if(previous==='soft' && sharpness<18) return 'soft';
      if(previous==='good' && sharpness>8) return 'good';
      if(sharpness>=16 || (edgeEnergy>=10 && contrast>=38)) return 'good';
      return 'soft';
    };

    const sizeScore=(size:number)=>{
      if(size<=0)return 0;
      if(size<0.18)return Math.max(0,size/0.18);
      if(size<0.30)return .45 + ((size-.18)/.12)*.55;
      if(size<=.62)return 1;
      if(size<=.76)return 1-((size-.62)/.14)*.55;
      return Math.max(.12,1-((size-.76)/.24)*.7);
    };

    const setRectFromBox=(box:{x:number;y:number;width:number;height:number},corners?:Array<{x:number;y:number}>)=>{
      // QR is fundamentally square. The tracker renders a padded square around
      // the decoded quadrilateral/bounding box so perspective changes don't make
      // the lock appear to wobble between a wide and tall rectangle.
      const rawSide=Math.max(box.width,box.height);
      const side=Math.max(8,rawSide*1.06);
      const cx=box.x+box.width/2;
      const cy=box.y+box.height/2;
      const square={
        x:Math.max(0,Math.min(frameWidth-side,cx-side/2)),
        y:Math.max(0,Math.min(frameHeight-side,cy-side/2)),
        width:Math.min(side,frameWidth),
        height:Math.min(side,frameHeight),
      };
      const videoBox=videoRef.current?.getBoundingClientRect();
      const elementWidth=Math.max(1,videoBox?.width ?? frameWidth);
      const elementHeight=Math.max(1,videoBox?.height ?? frameHeight);
      const frameRatio=frameWidth/Math.max(1,frameHeight);
      const elementRatio=elementWidth/elementHeight;
      const contentWidth=frameRatio>elementRatio ? elementWidth : elementHeight*frameRatio;
      const contentHeight=frameRatio>elementRatio ? elementWidth/frameRatio : elementHeight;
      const offsetX=(elementWidth-contentWidth)/2;
      const offsetY=(elementHeight-contentHeight)/2;
      const targetRect={
        left:Math.max(0,Math.min(100,(offsetX+(square.x/frameWidth)*contentWidth)/elementWidth*100)),
        top:Math.max(0,Math.min(100,(offsetY+(square.y/frameHeight)*contentHeight)/elementHeight*100)),
        width:Math.max(1,Math.min(100,(square.width/frameWidth)*contentWidth/elementWidth*100)),
        height:Math.max(1,Math.min(100,(square.height/frameHeight)*contentHeight/elementHeight*100)),
      };
      const quadCorners=(corners && corners.length>=4 ? corners.slice(0,4) : [
        {x:square.x,y:square.y},
        {x:square.x+square.width,y:square.y},
        {x:square.x+square.width,y:square.y+square.height},
        {x:square.x,y:square.y+square.height},
      ]).map(point=>({
        x:Math.max(0,Math.min(100,(offsetX+(point.x/frameWidth)*contentWidth)/elementWidth*100)),
        y:Math.max(0,Math.min(100,(offsetY+(point.y/frameHeight)*contentHeight)/elementHeight*100)),
      }));
      opticalVisualQuadTargetRef.current=quadCorners;
      if(!opticalVisualQuadCurrentRef.current){
        opticalVisualQuadCurrentRef.current=quadCorners;
        opticalVisualQuadVelocityRef.current=quadCorners.map(()=>({x:0,y:0}));
      }
      opticalVisualTargetRef.current=targetRect;
      // React only owns visibility. Position/size are mutated directly on the
      // overlay DOM node at display-frame cadence, avoiding a component-tree
      // render for every optical movement.
      if(!opticalGuideVisibleRef.current){
        opticalGuideVisibleRef.current=true;
        setOpticalGuideRect(targetRect);
      }
      if(!opticalVisualCurrentRef.current){
        opticalVisualCurrentRef.current=targetRect;
      }
    };

    const applyMessage=(title:string,detail:string,tone:OpticalGuideState['tone'],quality:number)=>{
      setOpticalGuide({tone,title,detail,quality:Math.round(Math.max(0,Math.min(100,quality)))});
    };

    const current=opticalTrackRef.current;

    const boxIoU=(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number})=>{
      const ax2=a.x+a.width, ay2=a.y+a.height;
      const bx2=b.x+b.width, by2=b.y+b.height;
      const ix=Math.max(0,Math.min(ax2,bx2)-Math.max(a.x,b.x));
      const iy=Math.max(0,Math.min(ay2,by2)-Math.max(a.y,b.y));
      const intersection=ix*iy;
      if(intersection<=0)return 0;
      return intersection/Math.max(1,a.width*a.height+b.width*b.height-intersection);
    };
    const association=(candidate:{x:number;y:number;width:number;height:number},reference:{x:number;y:number;width:number;height:number})=>{
      const candidateCx=candidate.x+candidate.width/2;
      const candidateCy=candidate.y+candidate.height/2;
      const referenceCx=reference.x+reference.width/2;
      const referenceCy=reference.y+reference.height/2;
      const diagonal=Math.max(8,Math.hypot(reference.width,reference.height));
      const centerDistance=Math.hypot(candidateCx-referenceCx,candidateCy-referenceCy)/diagonal;
      const centerScore=Math.exp(-Math.pow(centerDistance/.72,2));
      const widthRatio=Math.min(candidate.width/Math.max(1,reference.width),reference.width/Math.max(1,candidate.width));
      const heightRatio=Math.min(candidate.height/Math.max(1,reference.height),reference.height/Math.max(1,candidate.height));
      const sizeScore=Math.sqrt(Math.max(0,widthRatio*heightRatio));
      const overlap=boxIoU(candidate,reference);
      return .62*overlap+.28*centerScore+.10*sizeScore;
    };

    if(detected && boxes.length>0){
      const previous=current;
      const dt=Math.max(16,Math.min(300,now-(previous?.lastSeenAt ?? now)));
      const predicted=previous ? {
        x:previous.box.x+previous.vx*dt,
        y:previous.box.y+previous.vy*dt,
        width:Math.max(4,previous.box.width+previous.vw*dt),
        height:Math.max(4,previous.box.height+previous.vh*dt),
      } : boxes.reduce((best,box)=>box.width*box.height>best.width*best.height?box:best,boxes[0]);
      // Associate the new detections to the predicted target. This prevents
      // the old "largest QR wins" rule from jumping the lock to another lane
      // when several QRs are visible simultaneously.
      const ranked=boxes.map(box=>({box,score:previous?association(box,predicted):0}))
        .sort((a,b)=>previous ? b.score-a.score : (b.box.width*b.box.height)-(a.box.width*a.box.height));
      const selected=ranked[0].box;
      const associationScore=previous?ranked[0].score:1;

      // Lock hysteresis: when several QRs are visible, do not jump the visual
      // lock to a distant candidate on the first bad association. Hold the last
      // confirmed track for two detector cycles, then allow a deliberate switch
      // if the old target really disappeared or the camera moved elsewhere.
      if(previous?.confirmed && associationScore<.24){
        opticalAssociationBreakStreakRef.current+=1;
        if(opticalAssociationBreakStreakRef.current<3){
          const age=Math.max(0,now-previous.lastSeenAt);
          const keep={
            x:Math.max(0,Math.min(frameWidth-previous.box.width,predicted.x)),
            y:Math.max(0,Math.min(frameHeight-previous.box.height,predicted.y)),
            width:Math.min(frameWidth,Math.max(4,predicted.width)),
            height:Math.min(frameHeight,Math.max(4,predicted.height)),
          };
          opticalTrackRef.current={...previous,box:keep,vx:previous.vx*.88,vy:previous.vy*.88,vw:previous.vw*.88,vh:previous.vh*.88,confidence:Math.max(0,previous.confidence-.025),misses:previous.misses+1};
          setOpticalTrack({confidence:Math.max(0,previous.confidence-.025),predicted:true,ageMs:Math.round(age)});
          setRectFromBox(keep);
          setOpticalGuideDiagnostics({
            framing:'good',
            distance:'good',
            lighting:!metricsKnown?'unknown':classifyLighting(),
            stability:'moving',
            geometry:'good',
            focus:'unknown',
          });
          applyMessage('Maintaining QR lock','Another QR was briefly detected, but the tracker is preserving the confirmed target instead of jumping to it.','steady',Math.round(70+previous.confidence*20));
          return;
        }
      }else{
        opticalAssociationBreakStreakRef.current=0;
      }

      const primary=selected;
      const predictedForFilter=previous ? predicted : primary;
      // Adaptive alpha-beta filtering: alpha responds to movement and
      // confidence, while beta updates the velocity estimate from the same
      // residual. This follows fast camera pans without the "rubber band" lag
      // of a fixed exponential smoother.
      const residualX=primary.x-predictedForFilter.x;
      const residualY=primary.y-predictedForFilter.y;
      const residualW=primary.width-predictedForFilter.width;
      const residualH=primary.height-predictedForFilter.height;
      const referenceDiagonal=Math.max(16,Math.hypot(predictedForFilter.width,predictedForFilter.height));
      const residualSpeed=Math.hypot(residualX,residualY)/Math.max(1,dt*referenceDiagonal);
      const alpha=previous
        ? Math.min(.95,Math.max(.70,.76+Math.min(.12,residualSpeed*4)))
        : 1;
      const beta=previous
        ? Math.min(.36,Math.max(.14,.18+Math.min(.16,residualSpeed*5)))
        : 0;
      const smoothed={
        x:predictedForFilter.x+residualX*alpha,
        y:predictedForFilter.y+residualY*alpha,
        width:Math.max(4,predictedForFilter.width+residualW*alpha),
        height:Math.max(4,predictedForFilter.height+residualH*alpha),
      };
      const invDt=1/dt;
      const measuredVx=previous ? previous.vx+residualX*invDt*beta : 0;
      const measuredVy=previous ? previous.vy+residualY*invDt*beta : 0;
      const measuredVw=previous ? previous.vw+residualW*invDt*beta : 0;
      const measuredVh=previous ? previous.vh+residualH*invDt*beta : 0;
      // For multi-lane sender layouts, coach against the whole detected group
      // rather than whichever QR happens to be the largest. This prevents a
      // valid 4-lane screen from being treated as a single centered QR.
      const guideBox=boxes.length>1
        ? boxes.reduce((acc,box)=>({
            x:Math.min(acc.x,box.x),
            y:Math.min(acc.y,box.y),
            right:Math.max(acc.right,box.x+box.width),
            bottom:Math.max(acc.bottom,box.y+box.height),
          }),{
            x:primary.x,
            y:primary.y,
            right:primary.x+primary.width,
            bottom:primary.y+primary.height,
          })
        : {
            x:primary.x,
            y:primary.y,
            right:primary.x+primary.width,
            bottom:primary.y+primary.height,
          };
      const guideWidth=Math.max(1,guideBox.right-guideBox.x);
      const guideHeight=Math.max(1,guideBox.bottom-guideBox.y);
      const size=Math.min(guideWidth/Math.max(1,frameWidth),guideHeight/Math.max(1,frameHeight));
      const cx=(guideBox.x+guideWidth/2)/Math.max(1,frameWidth);
      const cy=(guideBox.y+guideHeight/2)/Math.max(1,frameHeight);
      const centered=Math.abs(cx-.5)<.10 && Math.abs(cy-.5)<.10;
      const primaryAspect=primary.width/Math.max(1,primary.height);
      const corners=primary.corners && primary.corners.length>=4 ? primary.corners.slice(0,4) : null;
      const rotationDeg=corners
        ? (Math.atan2(corners[1].y-corners[0].y,corners[1].x-corners[0].x)*180/Math.PI)
        : Number.NaN;
      const distanceBetween=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y);
      const perspectiveError=corners
        ? (()=>{
            const top=distanceBetween(corners[0],corners[1]);
            const right=distanceBetween(corners[1],corners[2]);
            const bottom=distanceBetween(corners[2],corners[3]);
            const left=distanceBetween(corners[3],corners[0]);
            const avgH=Math.max(1,(top+bottom)/2);
            const avgV=Math.max(1,(left+right)/2);
            return Math.max(Math.abs(top-bottom)/avgH,Math.abs(left-right)/avgV);
          })()
        : Math.max(0,Math.abs(Math.log(Math.max(.35,Math.min(2.8,primaryAspect)))));
      const perspectiveOk=perspectiveError<.30;
      const edgeMargin=.025;
      const cropped=guideBox.x/frameWidth<edgeMargin || guideBox.y/frameHeight<edgeMargin ||
        (guideBox.right/frameWidth)>(1-edgeMargin) || (guideBox.bottom/frameHeight)>(1-edgeMargin);
      const movement=previous
        ? Math.hypot((primary.x-previous.box.x)/Math.max(1,frameWidth),(primary.y-previous.box.y)/Math.max(1,frameHeight))
        : 0;
      const sizeMovement=previous
        ? Math.abs(primary.width-previous.box.width)/Math.max(1,frameWidth)
        : 0;
      const geometryPenalty=perspectiveOk?.0:.15;
      const cropPenalty=cropped?.12:0;
      const lightingPenalty=!metricsKnown?0:brightness<42?.18:clippedHighlights>.24 && contrast<48?.16:0;
      const sharpEnough=metricsKnown && (
        sharpness>=8 ||
        edgeEnergy>=7 ||
        contrast>=34
      );
      const currentConfidence=
        Math.max(0,
          .38*sizeScore(size)+
          .20*(centered?1:.35)+
          .12*(metricsKnown?(brightness>=42?1:.3):.6)+
          .10*(metricsKnown?(sharpEnough?1:.35):.6)+
          .08*(movement<.04?1:.5)+
          .07*(perspectiveOk?1:.35)+
          .05*(cropped?.25:1)-
          geometryPenalty-cropPenalty-lightingPenalty
        );

      opticalAssociationBreakStreakRef.current=0;
      const next:OpticalTrack={
        box:smoothed,
        vx:measuredVx,
        vy:measuredVy,
        vw:measuredVw,
        vh:measuredVh,
        lastSeenAt:now,
        confidence:previous ? previous.confidence*.45+currentConfidence*.55 : currentConfidence,
        misses:0,
        confirmed:false,
      };
      // A very low association score means the camera may have landed on a
      // different QR. It is still a real detection, so allow reacquisition,
      // but never let a far-away lane contaminate a strong locked prediction.
      const associationStrong=!previous || associationScore>=.24 || guideDetectionStreakRef.current<3;
      if(!associationStrong) guideStableCountRef.current=0;
      guideDetectionStreakRef.current=associationStrong
        ? Math.min(8,guideDetectionStreakRef.current+1)
        : 1;
      guideMissStreakRef.current=0;
      if(boxes.length>1){
        const group=boxes.reduce((acc,box)=>({
          x:Math.min(acc.x,box.x),
          y:Math.min(acc.y,box.y),
          right:Math.max(acc.right,box.x+box.width),
          bottom:Math.max(acc.bottom,box.y+box.height),
        }),{x:primary.x,y:primary.y,right:primary.x+primary.width,bottom:primary.y+primary.height});
        const measuredGroup={
          x:group.x,
          y:group.y,
          width:Math.max(1,group.right-group.x),
          height:Math.max(1,group.bottom-group.y),
        };
        const previousGroup=opticalGroupBoxRef.current;
        if(previousGroup){
          const groupDt=Math.max(.016,Math.min(.30,(now-opticalGroupLastSeenRef.current)/1000));
          const groupAlpha=.72;
          const gv=opticalGroupVelocityRef.current;
          const nextGroup={
            x:previousGroup.x+(measuredGroup.x-previousGroup.x)*groupAlpha,
            y:previousGroup.y+(measuredGroup.y-previousGroup.y)*groupAlpha,
            width:previousGroup.width+(measuredGroup.width-previousGroup.width)*groupAlpha,
            height:previousGroup.height+(measuredGroup.height-previousGroup.height)*groupAlpha,
          };
          const vx=(measuredGroup.x-previousGroup.x)/groupDt;
          const vy=(measuredGroup.y-previousGroup.y)/groupDt;
          const vw=(measuredGroup.width-previousGroup.width)/groupDt;
          const vh=(measuredGroup.height-previousGroup.height)/groupDt;
          gv.x=gv.x*.70+vx*.30;
          gv.y=gv.y*.70+vy*.30;
          gv.width=gv.width*.70+vw*.30;
          gv.height=gv.height*.70+vh*.30;
          opticalGroupBoxRef.current=nextGroup;
        }else{
          opticalGroupBoxRef.current=measuredGroup;
          opticalGroupVelocityRef.current={x:0,y:0,width:0,height:0};
        }
        opticalGroupLastSeenRef.current=now;
      }else if(opticalGroupBoxRef.current && now-opticalGroupLastSeenRef.current>1400){
        opticalGroupBoxRef.current=null;
        opticalGroupVelocityRef.current={x:0,y:0,width:0,height:0};
      }
      const confirmed=guideDetectionStreakRef.current>=3;
      opticalTrackRef.current={...next,confirmed};
      setOpticalTrack({confidence:next.confidence,predicted:false,ageMs:0});
      lastGuideBoxRef.current=primary;
      if(movement<.018) guideStableCountRef.current+=1;
      else if(movement>.045) guideStableCountRef.current=0;

      setRectFromBox(
        boxes.length>1
          ? {x:guideBox.x,y:guideBox.y,width:guideWidth,height:guideHeight}
          : next.box,
        boxes.length===1 && corners ? corners : undefined,
      );

      const previousDistance=guideDistanceRef.current;
      let distance:OpticalGuideDiagnostics['distance'];
      if(previousDistance==='too-far') distance=size<.27?'too-far':'good';
      else if(previousDistance==='too-close') distance=size>.72?'too-close':'good';
      else distance=size<.22?'too-far':size>.80?'too-close':'good';
      guideDistanceRef.current=distance;

      const stability=movement>.045 || sizeMovement>.035
        ?'moving'
        :guideStableCountRef.current>=5?'locked':'steady';
      const lighting:OpticalGuideDiagnostics['lighting']=!metricsKnown?'unknown':brightness<42?'dark':clippedHighlights>.24 && contrast<48?'glare':'good';
      const framing=centered?'good':'off';
      const rotationLarge=Number.isFinite(rotationDeg) && Math.abs(rotationDeg)>10;
      const geometry=cropped?'cropped':(!perspectiveOk || rotationLarge)?'tilted':'good';
      const focus=classifyFocus();
      guideLightingRef.current=lighting;
      guideFocusRef.current=focus;

      setOpticalGuideDiagnostics({framing,distance,lighting,stability,geometry,focus});

      // Instruction priority: environmental failure → geometry → focus →
      // motion → locked state. This avoids contradictory coaching.
      if(!confirmed){
        applyMessage('QR detected — locking on','A real QR was detected. Hold the phone steady for a moment while the optical guide confirms its position.','steady',35+next.confidence*20);
        return;
      }
      if(lighting==='dark'){
        applyMessage('Too dark — brighten the sender screen','Increase the sender brightness or ambient light. The QR is visible, but contrast is marginal for high-rate reading.','light',54+next.confidence*12);
        return;
      }
      if(lighting==='glare'){
        applyMessage('Reduce glare','Tilt the phone or sender screen a few degrees. Avoid bright reflections across the white QR area.','light',56+next.confidence*10);
        return;
      }
      if(geometry==='cropped'){
        const horizontal=guideBox.x<frameWidth*edgeMargin?'left':guideBox.right>frameWidth*(1-edgeMargin)?'right':'';
        const vertical=guideBox.y<frameHeight*edgeMargin?'up':guideBox.bottom>frameHeight*(1-edgeMargin)?'down':'';
        const direction=horizontal || vertical;
        if(size>.62 || boxes.length>1){
          applyMessage('Keep the full QR visible',direction
            ?`The QR is touching the ${direction} edge. Aim the camera ${direction} and back up slightly so every corner stays inside the frame.`
            :'The detected QR layout is close to the camera edge. Back up slightly so every corner stays visible.','farther',48+next.confidence*16);
          return;
        }
      }
      if(!perspectiveOk){
        applyMessage('Straighten the QR','The QR is detected, but its geometry is strongly skewed. Tilt or rotate the phone so the code faces the camera more squarely.','steady',60+next.confidence*12);
        return;
      }
      if(distance==='too-far'){
        applyMessage('Move closer',boxes.length>1
          ?`The ${boxes.length} QR lanes are too small. Move closer until the full sender layout is comfortably visible.`
          :'The QR is too small for reliable high-rate decoding. Move closer while keeping the complete code visible.','closer',40+sizeScore(size)*20);
        return;
      }
      if(distance==='too-close'){
        applyMessage('Move slightly farther away','Back up until the full QR and its clear white border fit inside the camera view.','farther',48+sizeScore(size)*20);
        return;
      }
      if(!centered){
        const horizontal=Math.abs(cx-.5);
        const vertical=Math.abs(cy-.5);
        const direction=horizontal>=vertical ? (cx<.5?'left':'right') : (cy<.5?'up':'down');
        applyMessage(`Aim ${direction}`,`The QR is about ${Math.round(Math.max(horizontal,vertical)*100)}% off-center. Shift the camera slightly ${direction} to bring it into the guide.`,'center',54+next.confidence*14);
        return;
      }
      if(focus==='soft'){
        applyMessage('Improve focus','Hold the phone steady for autofocus. If the code remains soft, move slightly farther away rather than zooming digitally.','steady',58+next.confidence*12);
        return;
      }
      if(stability==='moving'){
        applyMessage('Hold steady','The tracker has the QR, but camera motion is still high. Keep the phone steady so the decoder can maintain a clean optical lock.','steady',66+next.confidence*14);
        return;
      }
      if(boxes.length>1 && boxes.length<4){
        applyMessage(`${boxes.length} lanes tracked — widen the view`,'Part of the multi-QR layout is near the edge. Keep the entire sender display inside the camera frame.','steady',80+next.confidence*10);
        return;
      }
      if(stability==='locked'){
        applyMessage('QR LOCKED','Position and motion are stable. Keep this framing while the transfer runs.','ready',92+next.confidence*8);
        return;
      }
      applyMessage('QR tracked — keep steady',boxes.length>1
        ?`${boxes.length} QR lanes detected · keep the whole sender display visible`
        :'The tracker is following the QR in real time. Hold this position for the fastest reliable reads.','steady',82+next.confidence*12);
      return;
    }

    // A guide is only allowed to predict through a very short detector gap
    // after a QR has been independently confirmed. This prevents the coaching
    // system from inventing a QR when the camera is pointed at an empty scene.
    guideMissStreakRef.current+=1;
    const currentConfirmed=current?.confirmed===true;
    if(current && currentConfirmed && guideMissStreakRef.current<=3){
      const age=now-current.lastSeenAt;
      if(age<=320){
        const dt=Math.min(180,Math.max(0,age));
        const predicted={
          x:current.box.x+current.vx*dt,
          y:current.box.y+current.vy*dt,
          width:Math.max(4,current.box.width+current.vw*dt),
          height:Math.max(4,current.box.height+current.vh*dt),
        };
        const clamped={
          x:Math.max(0,Math.min(frameWidth-predicted.width,predicted.x)),
          y:Math.max(0,Math.min(frameHeight-predicted.height,predicted.y)),
          width:Math.min(frameWidth,predicted.width),
          height:Math.min(frameHeight,predicted.height),
        };
        const decayed=Math.max(0,current.confidence-Math.min(.38,age/840));
        opticalTrackRef.current={...current,box:clamped,vx:current.vx*.84,vy:current.vy*.84,vw:current.vw*.84,vh:current.vh*.84,confidence:decayed,misses:current.misses+1};
        setOpticalTrack({confidence:decayed,predicted:true,ageMs:Math.round(age)});
        setRectFromBox(clamped);

        const size=Math.min(clamped.width/Math.max(1,frameWidth),clamped.height/Math.max(1,frameHeight));
        const cx=(clamped.x+clamped.width/2)/Math.max(1,frameWidth);
        const cy=(clamped.y+clamped.height/2)/Math.max(1,frameHeight);
        const centered=Math.abs(cx-.5)<.12 && Math.abs(cy-.5)<.12;
        setOpticalGuideDiagnostics({
          framing:centered?'good':'off',
          distance:'good',
          lighting:!metricsKnown?'unknown':classifyLighting(),
          stability:'moving',
          geometry:'good',
          focus:'unknown',
        });
        applyMessage('Reacquiring QR…','The last confirmed QR was briefly lost. Hold steady; the decoder is checking the same region again.','steady',Math.round(42+decayed*28));
        return;
      }
    }

    // No confirmed QR is currently visible. We may still give environmental
    // advice when those conditions are actually measured, but never invent QR
    // position, distance, or geometry.
    guideDetectionStreakRef.current=0;
    if(metricsKnown){
      if(brightness<38){
        setOpticalGuideDiagnostics({
          framing:'searching',
          distance:'unknown',
          lighting:'dark',
          stability:'moving',
          geometry:'searching',
          focus:'unknown',
        });
        applyMessage(
          'Too dark to acquire the QR',
          'The camera image is measured at about '+Math.round(brightness)+'/255 brightness. Brighten the sender screen or the room, then aim at the QR.',
          'light',
          Math.max(8,Math.min(42,Math.round(brightness))),
        );
        opticalGuideVisibleRef.current=false;
        setOpticalGuideRect(null);
        return;
      }
      if(clippedHighlights>.34 && contrast<34){
        setOpticalGuideDiagnostics({
          framing:'searching',
          distance:'unknown',
          lighting:'glare',
          stability:'moving',
          geometry:'searching',
          focus:'unknown',
        });
        applyMessage(
          'Reduce glare',
          'Large bright regions are clipping in the camera image. Tilt the phone or sender display slightly to remove reflections.',
          'light',
          38,
        );
        opticalGuideVisibleRef.current=false;
        setOpticalGuideRect(null);
        return;
      }
    }
    guideMissStreakRef.current=Math.min(8,guideMissStreakRef.current);
    opticalTrackRef.current=null;
    opticalGroupBoxRef.current=null;
    opticalGroupVelocityRef.current={x:0,y:0,width:0,height:0};
    opticalGroupLastSeenRef.current=0;
    opticalVisualTargetRef.current=null;
    opticalVisualCurrentRef.current=null;
    opticalVisualVelocityRef.current={left:0,top:0,width:0,height:0};
    opticalVisualQuadTargetRef.current=null;
    opticalVisualQuadCurrentRef.current=null;
    opticalVisualQuadVelocityRef.current=[];
    opticalGuideVisibleRef.current=false;
    setOpticalTrack({confidence:0,predicted:false,ageMs:0});
    setOpticalGuideRect(null);
    guideDistanceRef.current='unknown';
    guideLightingRef.current='unknown';
    guideFocusRef.current='unknown';
    setOpticalGuideDiagnostics({framing:'searching',distance:'unknown',lighting:'unknown',stability:'moving',geometry:'searching',focus:'unknown'});
    applyMessage('No QR code detected','No valid QR code has been confirmed in the camera view. Point the camera at the sender screen or QR code.','searching',0);
  };

  function estimateOpticalFrameMetrics(
    image:ImageData,
    region?:{x:number;y:number;width:number;height:number},
  ):OpticalFrameMetrics{
    // Sample the actual lock region when available. The guide should judge
    // the QR itself, not an unrelated patch of the camera preview.
    const rx=Math.max(0,Math.floor(region?.x ?? 0));
    const ry=Math.max(0,Math.floor(region?.y ?? 0));
    const rw=Math.min(image.width-rx,Math.floor(region?.width ?? image.width));
    const rh=Math.min(image.height-ry,Math.floor(region?.height ?? image.height));
    const x0=Math.max(0,Math.min(image.width-1,rx));
    const y0=Math.max(0,Math.min(image.height-1,ry));
    const width=Math.max(1,rw);
    const height=Math.max(1,rh);
    const data=image.data;
    const area=width*height;
    const step=Math.max(2,Math.floor(Math.sqrt(area/1400)));
    let count=0;
    let sum=0;
    let sumSq=0;
    let edgeSum=0;
    let laplaceSum=0;
    let laplaceSq=0;
    let clipped=0;

    const lumaAt=(x:number,y:number)=>{
      const cx=Math.max(0,Math.min(image.width-1,x));
      const cy=Math.max(0,Math.min(image.height-1,y));
      const i=(cy*image.width+cx)*4;
      return 0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];
    };

    for(let y=y0;y<y0+height;y+=step){
      let previousLuma=-1;
      for(let x=x0;x<x0+width;x+=step){
        const luma=lumaAt(x,y);
        sum+=luma;
        sumSq+=luma*luma;
        if(luma>248) clipped+=1;
        if(previousLuma>=0) edgeSum+=Math.abs(luma-previousLuma);
        previousLuma=luma;

        if(
          x>x0+step && x<x0+width-step &&
          y>y0+step && y<y0+height-step
        ){
          const center=luma;
          const laplace=
            lumaAt(x-step,y)+
            lumaAt(x+step,y)+
            lumaAt(x,y-step)+
            lumaAt(x,y+step)-
            4*center;
          laplaceSum+=laplace;
          laplaceSq+=laplace*laplace;
        }
        count+=1;
      }
    }

    if(count===0) {
      return {
        brightness:128,
        contrast:64,
        edgeEnergy:18,
        clippedHighlights:0,
        sharpness:0,
        sampledPixels:0,
      };
    }
    const brightness=sum/count;
    const variance=Math.max(0,sumSq/count-brightness*brightness);
    const laplaceMean=laplaceSum/Math.max(1,count);
    const laplaceVariance=Math.max(
      0,
      laplaceSq/Math.max(1,count)-laplaceMean*laplaceMean,
    );
    return {
      brightness,
      contrast:Math.sqrt(variance),
      edgeEnergy:edgeSum/Math.max(1,count),
      clippedHighlights:clipped/count,
      // Variance of the discrete Laplacian is a lightweight focus/sharpness
      // proxy. It is computed sparsely and only over the relevant QR region.
      sharpness:Math.sqrt(laplaceVariance),
      sampledPixels:count,
    };
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
        // Hot path: once a QR is confirmed, decode a predicted local ROI instead
        // of repeatedly scanning the entire camera frame. This is the key speed
        // path for optical transport: fewer pixels, fewer cache misses, same QR
        // module resolution. A periodic full-frame probe keeps reacquisition safe.
        const misses=noDetectionDecodeCountRef.current;

        // Never spend canvas time preparing a frame while the adaptive
        // in-flight budget is saturated. This is deliberately stricter than
        // pool.available: stale optical frames are not useful enough to justify
        // burning CPU on a constrained phone.
        const concurrencyBudget=Math.max(1,Math.min(qrPoolRef.current.capacity,decodeParallelismRef.current));
        if(qrPoolRef.current.available<0 || qrPoolRef.current.busyCount>=concurrencyBudget){
          fallbackLoopRef.current=window.setTimeout(()=>void loop(),Math.max(16,Math.min(36,scanDelayRef.current)));
          return;
        }

        const track=opticalTrackRef.current;
        const trackAge=track ? performance.now()-track.lastSeenAt : Infinity;
        const canUseTrackedRoi=Boolean(track?.confirmed && trackAge<450 && track.misses<=2);
        const periodicFullRecovery=decoderCallsRef.current>0 && decoderCallsRef.current%8===0;
        const useTrackedRoi=canUseTrackedRoi && !periodicFullRecovery && misses<4;
        const retainedGroup=opticalGroupBoxRef.current && performance.now()-opticalGroupLastSeenRef.current<1600
          ? opticalGroupBoxRef.current
          : null;

        let roiX=0;
        let roiY=0;
        let roiWidth=sourceWidth;
        let roiHeight=sourceHeight;
        let image:ImageData;
        let width=0;
        let height=0;

        if(useTrackedRoi){
          const base=retainedGroup ?? track!.box;
          const predictMs=Math.min(100,Math.max(0,trackAge));
          const predictedX=retainedGroup
            ? base.x+opticalGroupVelocityRef.current.x*predictMs/1000
            : base.x+track!.vx*predictMs;
          const predictedY=retainedGroup
            ? base.y+opticalGroupVelocityRef.current.y*predictMs/1000
            : base.y+track!.vy*predictMs;
          const predictedW=Math.max(12,retainedGroup
            ? base.width+opticalGroupVelocityRef.current.width*predictMs/1000
            : base.width+track!.vw*predictMs);
          const predictedH=Math.max(12,retainedGroup
            ? base.height+opticalGroupVelocityRef.current.height*predictMs/1000
            : base.height+track!.vh*predictMs);
          // Motion padding grows with estimated camera velocity so a fast pan does
          // not outrun the ROI. The minimum border also protects perspective corners.
          const motionPadX=Math.max(28,Math.abs(track!.vx)*90);
          const motionPadY=Math.max(28,Math.abs(track!.vy)*90);
          const margin=retainedGroup?.width && retainedGroup.width>sourceWidth*.5 ? .20 : .42;
          roiX=Math.max(0,Math.floor(predictedX-predictedW*margin-motionPadX));
          roiY=Math.max(0,Math.floor(predictedY-predictedH*margin-motionPadY));
          const right=Math.min(sourceWidth,Math.ceil(predictedX+predictedW*(1+margin)+motionPadX));
          const bottom=Math.min(sourceHeight,Math.ceil(predictedY+predictedH*(1+margin)+motionPadY));
          roiWidth=Math.max(16,right-roiX);
          roiHeight=Math.max(16,bottom-roiY);
          const target=720;
          const scale=Math.min(1,target/Math.max(roiWidth,roiHeight));
          width=Math.max(1,Math.round(roiWidth*scale));
          height=Math.max(1,Math.round(roiHeight*scale));
          if(recoveryCanvas.width!==width)recoveryCanvas.width=width;
          if(recoveryCanvas.height!==height)recoveryCanvas.height=height;
          recoveryCtx.imageSmoothingEnabled=false;
          recoveryCtx.drawImage(video,roiX,roiY,roiWidth,roiHeight,0,0,width,height);
          image=recoveryCtx.getImageData(0,0,width,height);
        }else if(misses%4!==3){
          // Acquisition mode: center crop exploits the square QR geometry while
          // keeping the first lock cheap. The 4th sample is full-frame recovery.
          const cropSize=Math.min(sourceWidth,sourceHeight);
          const target=720;
          const scale=Math.min(1,target/cropSize);
          width=Math.max(1,Math.round(cropSize*scale));
          height=width;
          roiX=Math.floor((sourceWidth-cropSize)/2);
          roiY=Math.floor((sourceHeight-cropSize)/2);
          roiWidth=cropSize;
          roiHeight=cropSize;
          if(recoveryCanvas.width!==width)recoveryCanvas.width=width;
          if(recoveryCanvas.height!==height)recoveryCanvas.height=height;
          recoveryCtx.imageSmoothingEnabled=false;
          recoveryCtx.drawImage(video,roiX,roiY,roiWidth,roiHeight,0,0,width,height);
          image=recoveryCtx.getImageData(0,0,width,height);
        }else{
          // Full-frame recovery is deliberately bounded to ~720 px on the hot path.
          const maxDimension=Math.min(720,decodeMaxDimensionRef.current);
          const scale=Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight));
          width=Math.max(1,Math.round(sourceWidth*scale));
          height=Math.max(1,Math.round(sourceHeight*scale));
          if(canvas.width!==width)canvas.width=width;
          if(canvas.height!==height)canvas.height=height;
          roiX=0; roiY=0; roiWidth=sourceWidth; roiHeight=sourceHeight;
          ctx.imageSmoothingEnabled=false;
          ctx.drawImage(video,0,0,width,height);
          image=ctx.getImageData(0,0,width,height);
        }

        // A single-code tracked ROI can ask ZXing to stop after its first valid
        // symbol. Full-frame and multi-lane recovery still decode up to four codes.
        const maxSymbols=useTrackedRoi && !retainedGroup ? 1 : 4;
        const decodeDepth=misses>=8 || decoderCallsRef.current%6===0 ? 1 : 0;
        const frameSequence=++opticalDecodeSequenceRef.current;
        const job=qrPoolRef.current.decode(image.data.buffer,width,height,decodeDepth,maxSymbols);
        if(job){
          decoderCallsRef.current+=1;
          void job.then(async decoded=>{
            const processStarted=performance.now();
            qrDetectionsRef.current+=decoded.values.length;

            // Only the newest completed capture may move the optical guide. A
            // result from an older parallel worker is still valid transport data,
            // but its geometry is stale and would create visible backwards jumps.
            const isNewestGeometry=frameSequence>=opticalLatestGeometrySequenceRef.current;
            if(isNewestGeometry){
              opticalLatestGeometrySequenceRef.current=frameSequence;
              const metricRegion=decoded.boxes?.length
                ? decoded.boxes.reduce((acc,box)=>({
                    x:Math.min(acc.x,box.x),
                    y:Math.min(acc.y,box.y),
                    right:Math.max(acc.right,box.x+box.width),
                    bottom:Math.max(acc.bottom,box.y+box.height),
                  }),{
                    x:decoded.boxes[0].x,
                    y:decoded.boxes[0].y,
                    right:decoded.boxes[0].x+decoded.boxes[0].width,
                    bottom:decoded.boxes[0].y+decoded.boxes[0].height,
                  })
                : undefined;
              const frameMetrics=estimateOpticalFrameMetrics(
                image,
                metricRegion
                  ? {
                      x:Math.max(0,metricRegion.x-8),
                      y:Math.max(0,metricRegion.y-8),
                      width:Math.min(width,metricRegion.right-metricRegion.x+16),
                      height:Math.min(height,metricRegion.bottom-metricRegion.y+16),
                    }
                  : undefined,
              );
              if(decoded.values.length>0){
                const scaleX=roiWidth/Math.max(1,width);
                const scaleY=roiHeight/Math.max(1,height);
                const guideBoxes=(decoded.boxes ?? []).map(box=>({
                  x:Math.floor(roiX+box.x*scaleX),
                  y:Math.floor(roiY+box.y*scaleY),
                  width:Math.max(1,Math.floor(box.width*scaleX)),
                  height:Math.max(1,Math.floor(box.height*scaleY)),
                  corners:box.corners?.map(point=>({x:roiX+point.x*scaleX,y:roiY+point.y*scaleY})),
                }));
                updateOpticalGuide(guideBoxes,sourceWidth,sourceHeight,true,frameMetrics);
              }else{
                updateOpticalGuide([],sourceWidth,sourceHeight,false,frameMetrics);
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

            // Adapt both capture pacing and decoder parallelism to measured
            // latency. Slow devices stay at one in-flight decode; fast devices
            // earn additional lanes only after several healthy samples.
            scanDelayRef.current=decoded.processingMs>150
              ?Math.min(70,Math.max(40,Math.round(decoded.processingMs*.28)))
              :decoded.processingMs>75
                ?Math.min(60,Math.max(35,Math.round(decoded.processingMs*.32)))
                :decoded.values.length>0
                  ?Math.max(16,scanDelayRef.current-4)
                  :Math.min(50,scanDelayRef.current+2);

            const perf=decodePerfWindowRef.current;
            perf.samples+=1;
            perf.totalMs+=decoded.processingMs;
            if(perf.samples>=6){
              const avgMs=perf.totalMs/perf.samples;
              const capacity=qrPoolRef.current?.healthyCount ?? 1;
              if(avgMs<42 && decoded.processingMs<55){
                decodeParallelismRef.current=Math.min(capacity,decodeParallelismRef.current+1);
              }else if(avgMs>125 || decoded.processingMs>180){
                decodeParallelismRef.current=Math.max(1,decodeParallelismRef.current-1);
              }else if(avgMs>82){
                decodeParallelismRef.current=Math.max(1,decodeParallelismRef.current-1);
              }
              perf.samples=0;
              perf.totalMs=0;
            }
          }).catch(e=>{
            if(receivingRef.current)setError(e instanceof Error?e.message:'QR decoder worker failed.');
          });
        }
      }

      if(receivingRef.current && fallbackActiveRef.current){
        const liveVideo=videoRef.current as (HTMLVideoElement & {
          requestVideoFrameCallback?:(callback:(now:number,metadata:VideoFrameCallbackMetadata)=>void)=>number;
        }) | null;
        if(liveVideo?.requestVideoFrameCallback){
          // Decode exactly once per camera-presented frame. This removes timer
          // drift and duplicate processing when the camera is delivering 30/60 FPS.
          fallbackUsesRvfcRef.current=true;
          fallbackLoopRef.current=liveVideo.requestVideoFrameCallback(()=>void loop());
        }else{
          fallbackUsesRvfcRef.current=false;
          fallbackLoopRef.current=window.setTimeout(()=>void loop(),Math.max(16,Math.min(50,scanDelayRef.current)));
        }
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
    opticalVisualTargetRef.current=null;
    opticalVisualCurrentRef.current=null;
    opticalVisualVelocityRef.current={left:0,top:0,width:0,height:0};
    opticalGuideVisibleRef.current=false;
    setOpticalGuideRect(null);
    opticalTrackRef.current=null;
    opticalGroupBoxRef.current=null;
    opticalGroupLastSeenRef.current=0;
    setOpticalTrack({confidence:0,predicted:false,ageMs:0});
    setOpticalGuideDiagnostics({framing:'searching',distance:'unknown',lighting:'unknown',stability:'moving',geometry:'searching',focus:'unknown'});
    setOpticalGuide({tone:'searching',title:'Looking for the sender screen…',detail:'Point your camera at the QR stream.',quality:0});
    setAckPayload('');
    receiverStartedRef.current=null;solvedRef.current=0;duplicateCountRef.current=0;
    detectedWindowRef.current={started:0,count:0};scanDelayRef.current=55;
    cameraFramesRef.current=0;decoderCallsRef.current=0;qrDetectionsRef.current=0;acceptedTransferFramesRef.current=0;lastDetectionRef.current='—';telemetryTickRef.current=0;
    decodeMaxDimensionRef.current=1120;
    noDetectionDecodeCountRef.current=0;
    opticalDecodeSequenceRef.current=0;
    opticalLatestGeometrySequenceRef.current=0;
    opticalAssociationBreakStreakRef.current=0;
    decodeParallelismRef.current=1;
    decodePerfWindowRef.current={samples:0,totalMs:0};
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

      // Prefer a real 60 FPS / 1280-wide camera mode when the device exposes it.
      // This keeps enough pixels for dense QR grids while cutting the CPU/GPU
      // cost of pushing 1080p/4K camera frames through the decoder pool.
      try{
        const caps=videoTrack.getCapabilities?.() as MediaTrackCapabilities & {frameRate?:{max?:number};width?:{max?:number}};
        if((caps.frameRate?.max ?? 0)>=60){
          await videoTrack.applyConstraints({
            frameRate:{exact:60},
            width:{ideal:1280,max:1280},
            height:{ideal:720,max:720},
          });
        }
      }catch{
        // Keep the successfully opened stream when the browser refuses a live
        // reconfiguration (common on mobile Safari).
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
      // The deterministic worker is always the primary acquisition path.
      // Browser/native barcode engines are opportunistic accelerators only;
      // they must never gate the receiver or become a single point of slowdown.
      startFallbackReading();
      void startNativeQrAssist();
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
        <div className="mt-4 rounded-[22px] border border-cyan-300/20 bg-cyan-300/[.06] p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl bg-cyan-300/15 p-2 text-cyan-200"><Radio size={16}/></div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-black text-cyan-100">Physical high-speed mode</p>
              <p className="mt-1 text-[10px] leading-5 text-[var(--text-muted)]">For phone-to-phone or tablet-to-phone transfer, use the native OptiFrame surface: one large optical frame instead of multiple tiny QR codes.</p>
              <Link to="/optiframe" className="mt-2 inline-flex rounded-full bg-white px-3 py-1.5 text-[10px] font-black text-slate-950">Open OptiFrame transfer →</Link>
            </div>
          </div>
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
          <label className="rounded-xl bg-white/5 p-3 text-xs font-bold">Automatic speed<select value={autoTune?'on':'off'} onChange={e=>setAutoTune(e.target.value==='on')} className="mt-2 w-full rounded-lg bg-black/20 p-2 text-xs"><option value="on">On</option><option value="off">Off</option></select></label><label className="rounded-xl bg-white/5 p-3 text-xs font-bold">Sharing speed<select value={intervalMs} onChange={e=>setIntervalMs(Number(e.target.value))} className="mt-2 w-full rounded-lg bg-black/20 p-2 text-xs"><option value="16">60 FPS</option><option value="24">50 FPS</option><option value="35">Very fast</option><option value="45">Fast</option><option value="60">Balanced</option><option value="90">Reliable</option><option value="150">Extra reliable</option></select></label><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Behind the scenes</b><p className="mt-1 text-[var(--text-muted)]">{telemetry.encoderWorkers>0?telemetry.encoderWorkers+' worker encoder':'main-thread fallback'} · {telemetry.prefetchReady}/{getRenderPrefetchWindow()} groups ready</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Screen update</b><p className="mt-1 text-[var(--text-muted)]">{telemetry.renderMs.toFixed(1)} ms · QR encode {telemetry.encodeMs.toFixed(1)} ms</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>File per screen</b><p className="mt-1 text-[var(--text-muted)]">{fountain ? FOUNTAIN_BLOCK_BYTES + ' bytes/block' : (compat?.bytesPerFrame ?? OR_TRANSFER_BYTES_PER_FRAME) + ' raw bytes/frame · 1× dwell per frame'}</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Codes on screen</b><p className="mt-1 text-[var(--text-muted)]">{getDisplayLaneCount()} QR code{getDisplayLaneCount() === 1 ? "" : "s"} · Touch devices use one large code for easier physical camera acquisition.</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Missed parts</b><p className="mt-1 text-[var(--text-muted)]">{fountain?'Extra recovery':'Simple sharing'}</p></div></div>}
        </>}
      </div>
    </div> : <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_.8fr]">
      <div className="transfer-camera glass-panel overflow-hidden rounded-[28px] p-4">
        <div className="relative overflow-hidden rounded-2xl bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-[min(72vh,720px)] min-h-[480px] w-full rounded-2xl bg-black object-contain sm:min-h-[560px]"
          />
          {receiving&&(
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-0 grid place-items-center">
                <div className={`relative aspect-square w-[72%] max-w-[560px] rounded-[28px] border-2 transition-colors duration-300 ${opticalGuide.tone==='ready'
                  ? 'border-emerald-300 shadow-[0_0_32px_rgba(52,211,153,.28)]'
                  : opticalGuide.tone==='closer'||opticalGuide.tone==='farther'
                    ? 'border-amber-300 shadow-[0_0_32px_rgba(251,191,36,.22)]'
                    : opticalGuide.tone==='searching'
                      ? 'border-white/20 border-dashed shadow-[0_0_0_9999px_rgba(0,0,0,.12)]'
                      : 'border-cyan-300/70 shadow-[0_0_0_9999px_rgba(0,0,0,.18)]'}`}>
                  <span className="absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/75 px-3 py-1.5 text-[10px] font-black text-white">
                    {opticalGuide.title}
                  </span>
                </div>
              </div>

              {opticalGuideRect&&(
                <svg
                  className="pointer-events-none absolute inset-0 z-[5] h-full w-full overflow-visible text-cyan-300"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polygon
                    ref={opticalGuidePolygonRef}
                    points="0,0 0,0 0,0 0,0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="0.45"
                    vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round"
                    style={{opacity:0}}
                  />
                </svg>
              )}

              {opticalGuideRect&&(
                <div
                  ref={opticalGuideOverlayRef}
                  className="absolute will-change-[left,top,width,height]"
                >
                  <div className={opticalTrack.predicted
                    ? 'absolute inset-0 rounded-[22px] border border-cyan-200/70 opacity-60'
                    : opticalGuide.tone==='ready'
                      ? 'absolute inset-0 rounded-[22px] border-2 border-emerald-300 shadow-[0_0_32px_rgba(52,211,153,.28)]'
                      : 'absolute inset-0 rounded-[22px] border-2 border-cyan-300 shadow-[0_0_26px_rgba(103,232,249,.24)]'}>
                    <span className="absolute left-0 top-0 h-7 w-7 rounded-tl-xl border-l-4 border-t-4 border-current text-cyan-200"></span>
                    <span className="absolute right-0 top-0 h-7 w-7 rounded-tr-xl border-r-4 border-t-4 border-current text-cyan-200"></span>
                    <span className="absolute bottom-0 left-0 h-7 w-7 rounded-bl-xl border-b-4 border-l-4 border-current text-cyan-200"></span>
                    <span className="absolute bottom-0 right-0 h-7 w-7 rounded-br-xl border-b-4 border-r-4 border-current text-cyan-200"></span>
                    <div className="absolute left-[12%] right-[12%] top-1/2 h-px bg-cyan-200/35"></div>
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/15 bg-black/75 px-2.5 py-1 text-[9px] font-black tracking-wide text-white backdrop-blur-md">
                      {opticalTrack.predicted?'TRACKING':'QR LOCK'} · {Math.round(opticalTrack.confidence*100)}%
                    </div>
                  </div>
                  {opticalGuide.tone==='ready'&&(
                    <div className="absolute -inset-1 rounded-[24px] border border-emerald-300/50 animate-pulse"></div>
                  )}
                </div>
              )}

              <div className="absolute bottom-4 left-1/2 w-[min(92%,440px)] -translate-x-1/2 rounded-2xl border border-white/15 bg-black/75 px-4 py-3 text-center text-white shadow-2xl backdrop-blur-md">
                <p className="text-[9px] font-black uppercase tracking-[.18em] text-cyan-200">OptiGuide</p>
                <p aria-live="polite" className="mt-1 text-sm font-black">{opticalGuide.title}</p>
                <p className="mt-1 text-[10px] leading-4 text-white/75">{opticalGuide.detail}</p>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15">
                  <div
                    className="h-full rounded-full bg-cyan-300 transition-all duration-300"
                    style={{width:opticalGuide.quality+'%'}}
                  />
                </div>
              </div>
            </div>
          )}
          {ackPayload&&(
            <div className="pointer-events-none absolute bottom-3 right-3 rounded-2xl border border-cyan-300/40 bg-white/95 p-2 shadow-2xl">
              <p className="mb-1 text-center text-[9px] font-black text-slate-950">RECEIVING STATUS</p>
              <canvas
                ref={ackCanvasRef}
                className="h-[180px] w-[180px] rounded-lg"
                aria-label="OptiTransfer receiver acknowledgement QR"
              />
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={()=>{if(receiving){setAckPayload('');stopReceive();}else void startReceive();}}
            className="rounded-full bg-white px-4 py-2 text-sm font-black text-slate-950"
          >
            {receiving?'Stop receiver':'Start receiver'}
          </button>
          <span className="rounded-full bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-300">
            {receiving?'Scanning':'Camera off'}
          </span>
          {receiving&&(
            <button
              onClick={startBenchmark}
              className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-bold text-cyan-200"
            >
              {benchmarking?'Benchmarking…':'Speed test'}
            </button>
          )}
        </div>
      </div>
      <div className="transfer-receiver-panel glass-panel rounded-[28px] p-5"><LockKeyhole size={20} className="text-cyan-300"/><p className="mt-3 font-bold">Easy receiving</p><p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">The receiver uses several ways to read the code so it can keep working when the camera misses a frame.</p><div className="mt-4 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.05] p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[.14em] text-cyan-200">OptiGuide</p><p className="mt-1 text-base font-black">{opticalGuide.title}</p><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{opticalGuide.detail}</p></div><div className="shrink-0 text-right"><p className="text-[10px] text-[var(--text-muted)]">Reading quality</p><p className="text-lg font-black">{opticalGuide.quality}%</p></div></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all duration-300" style={{width:opticalGuide.quality+'%'}}/></div><p className="mt-3 text-[10px] leading-4 text-[var(--text-muted)]">Live coaching checks framing, distance, lighting and movement from the camera feed.</p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3"><div className="rounded-xl bg-white/5 p-2.5"><p className="text-[9px] uppercase tracking-[.12em] text-[var(--text-muted)]">Framing</p><p className="mt-1 text-[11px] font-black">{opticalGuideDiagnostics.framing==='good'?'✓ In target':opticalGuideDiagnostics.framing==='off'?'↔ Re-center':'Searching'}</p></div><div className="rounded-xl bg-white/5 p-2.5"><p className="text-[9px] uppercase tracking-[.12em] text-[var(--text-muted)]">Distance</p><p className="mt-1 text-[11px] font-black">{opticalGuideDiagnostics.distance==='too-far'?'↑ Move closer':opticalGuideDiagnostics.distance==='too-close'?'↓ Move farther':opticalGuideDiagnostics.distance==='good'?'✓ In range':'—'}</p></div><div className="rounded-xl bg-white/5 p-2.5"><p className="text-[9px] uppercase tracking-[.12em] text-[var(--text-muted)]">Lighting</p><p className="mt-1 text-[11px] font-black">{opticalGuideDiagnostics.lighting==='dark'?'☀ Brighter':opticalGuideDiagnostics.lighting==='glare'?'◐ Reduce glare':opticalGuideDiagnostics.lighting==='good'?'✓ Good':'—'}</p></div><div className="rounded-xl bg-white/5 p-2.5"><p className="text-[9px] uppercase tracking-[.12em] text-[var(--text-muted)]">Stability</p><p className="mt-1 text-[11px] font-black">{opticalGuideDiagnostics.stability==='moving'?'Hold steady':opticalGuideDiagnostics.stability==='locked'?'✓ Locked':'Steady'}</p></div><div className="rounded-xl bg-white/5 p-2.5"><p className="text-[9px] uppercase tracking-[.12em] text-[var(--text-muted)]">Geometry</p><p className="mt-1 text-[11px] font-black">{opticalGuideDiagnostics.geometry==='tilted'?'↻ Straighten':opticalGuideDiagnostics.geometry==='cropped'?'□ Keep corners visible':opticalGuideDiagnostics.geometry==='good'?'✓ Square':'Searching'}</p></div><div className="rounded-xl bg-white/5 p-2.5"><p className="text-[9px] uppercase tracking-[.12em] text-[var(--text-muted)]">Focus</p><p className="mt-1 text-[11px] font-black">{opticalGuideDiagnostics.focus==='soft'?'⌁ Improve focus':opticalGuideDiagnostics.focus==='good'?'✓ Detail':'—'}</p></div></div></div><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-2xl bg-cyan-300/[.06] p-3"><Activity size={16} className="text-cyan-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Camera</p><p className="mt-1 text-sm font-black">{telemetry.cameraFrames}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">checks</p></div>
          <div className="rounded-2xl bg-cyan-300/[.06] p-3"><ScanLine size={16} className="text-cyan-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Code reads</p><p className="mt-1 text-sm font-black">{telemetry.qrDetections}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{telemetry.detectedPerSecond.toFixed(1)}/s</p></div>
          <div className="rounded-2xl bg-white/5 p-3"><TimerReset size={16} className="text-white/70"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Reading</p><p className="mt-1 text-sm font-black">{telemetry.decodeMs.toFixed(0)} ms</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{telemetry.decoderCalls} worker decodes · {telemetry.nativeAssist?'native QR assist':'worker QR primary'}</p></div>
          <div className="rounded-2xl bg-white/5 p-3"><ShieldCheck size={16} className="text-emerald-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Parts received</p><p className="mt-1 text-sm font-black">{telemetry.transferFrames}</p><p className="mt-1 truncate text-[10px] text-[var(--text-muted)]">{telemetry.lastDetection}</p></div>
        </div>
        {receiving&&<div className="mt-3 rounded-2xl bg-white/5 p-3 text-[10px] leading-5 text-[var(--text-muted)]"><span className="font-bold text-white/80">Camera status:</span> {probeStatus === 'Not run' ? 'Ready' : probeStatus}</div>}
        {benchmark&&<div className="mt-5 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.05] p-4"><div className="flex items-center justify-between gap-2"><p className="text-xs font-bold uppercase tracking-[.14em] text-cyan-200">Physical 1 MB benchmark</p><span className="text-[10px] text-[var(--text-muted)]">{(benchmark.durationMs/1000).toFixed(1)} s</span></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><p className="text-[10px] text-[var(--text-muted)]">Sustained</p><p className="text-sm font-black">{benchmark.goodputKbps.toFixed(1)} KB/s</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Peak ≥1s</p><p className="text-sm font-black">{benchmark.peakGoodputKbps.toFixed(1)} KB/s</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Codes/sec</p><p className="text-sm font-black">{benchmark.sustainedDecodeRate.toFixed(1)} / {benchmark.peakDecodeRate.toFixed(1)}</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Unique codes</p><p className="text-sm font-black">{benchmark.uniqueCodes}</p></div></div><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl bg-white/5 p-3"><p className="text-[10px] text-[var(--text-muted)]">Decimen desktop→phone reference</p><p className="mt-1 text-xs font-bold">418.5 KB/s sustained · 601.5 KB/s peak</p></div><div className="rounded-xl bg-white/5 p-3"><p className="text-[10px] text-[var(--text-muted)]">Decimen phone→phone reference</p><p className="mt-1 text-xs font-bold">199.2 KB/s sustained · 340.8 KB/s peak</p></div></div><p className="mt-3 text-[10px] leading-5 text-[var(--text-muted)]">Run this on the actual device pair. The result is a measurement, not a simulated claim. To establish a “better than Decimen” result, repeat the same 1 MB, 10-second methodology on a comparable device pair and compare sustained and ≥1-second peak goodput.</p></div>}{progress&&<div className="mt-5 rounded-2xl bg-white/5 p-4"><p className="truncate text-sm font-bold">{progress.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{Math.min(100,Math.round(progress.received/Math.max(1,progress.total)*100))}% complete</p><div className="mt-3 h-2 rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all" style={{width:Math.min(100,Math.round(progress.received/progress.total*100)) + '%'}}/></div></div>}{result&&<div className="mt-5 rounded-2xl bg-emerald-400/10 p-4"><CheckCircle2 className="text-emerald-300"/><p className="mt-2 font-bold">File received and checked</p><p className="mt-1 truncate text-xs text-[var(--text-muted)]">{result.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{(result.size/1024/1024).toFixed(2)} MB · Ready to use</p>{result.mime.startsWith('image/')&&<img src={result.url} alt={result.name} className="mt-4 max-h-80 w-full rounded-xl object-contain bg-black/20" />}{result.mime==='application/pdf'&&<iframe src={result.url} title={result.name} className="mt-4 h-80 w-full rounded-xl bg-white" /> }<div className="mt-4 flex flex-wrap gap-2"><a href={result.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-cyan-300 px-4 py-2 text-sm font-bold text-slate-950">Open / View</a><a href={result.url} download={result.name} className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-950"><Download size={14}/> Save file</a></div></div>}{error&&<p className="mt-5 rounded-2xl bg-rose-400/10 p-4 text-sm text-rose-200">{error}</p>}</div>
    </div>}
    <div className="mt-5 grid gap-3 md:grid-cols-3">{[['01','Encode','The app prepares the file for sharing.'],['02','Stream','The file is shown on the screen for the other device to read.'],['03','Recover','If something is missed, the app automatically works around it and checks the finished file.']].map(([n,t,d])=><div key={n} className="glass-panel rounded-[24px] p-5"><span className="text-xs font-black text-cyan-300">{n}</span><h2 className="mt-2 font-bold">{t}</h2><p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">{d}</p></div>)}</div>
  </section>;
}
