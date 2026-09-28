import { useEffect, useRef, useState } from 'react';
import { Activity, CheckCircle2, Download, FileUp, Gauge, LockKeyhole, Radio, ScanLine, ShieldCheck, TimerReset, WifiOff, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BrowserQRCodeReader } from '@zxing/browser';
import { QrDecodePool } from '../../lib/qrDecodePool';
import { createBenchmarkStart, finishBenchmark, type BenchmarkSample, type OpticalBenchmark } from '../../lib/opticalBenchmark';
import { OR_TRANSFER_GRID_SIZE, addTransferFrame, createTransfer, isTransferFrame, parseTransferFrame, reconstructTransfer } from '../../lib/orTransfer';
import { createQrMatrices, drawQrMatricesToCanvas } from '../../lib/qrCanvas';
import { QrEncodePool, type QrEncodeResult } from '../../lib/qrEncodePool';
import { createFountainDecoder, createFountainTransfer, FOUNTAIN_BLOCK_BYTES, FOUNTAIN_GRID_SIZE, isFountainFrame, parseFountainFrame, type FountainDecoder, type FountainDroplet, type FountainPlan } from '../../lib/fountain';
import { addMultiImageChunk, isMultiImageQr, reconstructMultiImage } from '../../lib/imageQr';
import type { QrMatrix } from '../../lib/qrEncodePool';

type Detector = { detect:(source:HTMLVideoElement)=>Promise<Array<{rawValue?:string}>> };
type DetectorCtor = {
  new (options?:{formats?:string[]}): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};

type Result = { url:string; name:string; size:number };
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
  lastDetection:string;
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
  const [mode,setMode]=useState<'fountain'|'compatibility'>('compatibility');
  const [file,setFile]=useState<File|null>(null);
  const [fountain,setFountain]=useState<FountainPlan|null>(null);
  const [compat,setCompat]=useState<Awaited<ReturnType<typeof createTransfer>>|null>(null);
  const [group,setGroup]=useState(0);
  const [playing,setPlaying]=useState(false);
  const [intervalMs,setIntervalMs]=useState(700);
  const [error,setError]=useState('');
  const [receiving,setReceiving]=useState(false);
  const [progress,setProgress]=useState<Progress|null>(null);
  const [result,setResult]=useState<Result|null>(null);
  const [compatMissing,setCompatMissing]=useState<number|null>(null);
  const [autoTune,setAutoTune]=useState(false);
  const [benchmarking,setBenchmarking]=useState(false);
  const [benchmark,setBenchmark]=useState<OpticalBenchmark|null>(null);
  const [telemetry,setTelemetry]=useState<Telemetry>({startedAt:null,renderMs:0,encodeMs:0,prefetchReady:0,encoderWorkers:0,renderCount:0,renderFps:0,detectedPerSecond:0,solvedPerSecond:0,goodputKbps:0,duplicates:0,decodeMs:0,processMs:0,scanDelayMs:55,cameraFrames:0,decoderCalls:0,qrDetections:0,transferFrames:0,lastDetection:'—'});
  const [screenAwake,setScreenAwake]=useState(false);
  const inputRef=useRef<HTMLInputElement>(null);
  const videoRef=useRef<HTMLVideoElement>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const detectorRef=useRef<Detector|null>(null);
  const zxingReaderRef=useRef<BrowserQRCodeReader|null>(null);
  const zxingControlsRef=useRef<{stop:()=>void}|null>(null);
  const receivingRef=useRef(false);
  const fallbackCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const qrPoolRef=useRef<QrDecodePool|null>(null);
  const timerRef=useRef<number|null>(null);
  const playbackRafRef=useRef<number|null>(null);
  const playbackLastAtRef=useRef(0);
  const playbackGroupRef=useRef(0);
  const playbackPlanKeyRef=useRef<string | null>(null);
  const playbackFountainRef=useRef(false);
  const playbackPrefetchRef=useRef<Set<string>>(new Set());
  const qrEncoderRef=useRef<QrEncodePool|null>(null);
  const qrCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const renderCacheRef=useRef<Map<string,{matrices:QrMatrix[];renderMs:number;encodeMs:number}>>(new Map());
  const renderEpochRef=useRef(0);
  const renderWindowStatsRef=useRef({started:0,count:0,renderMs:0});
  const fountainDecoderRef=useRef<FountainDecoder|null>(null);
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
  const nativeMissRef=useRef(0);
  const nativeSlowRef=useRef(0);
  const fallbackLoopRef=useRef<number|null>(null);
  const fallbackActiveRef=useRef(false);
  const zxingFallbackTimerRef=useRef<number|null>(null);
  const decodeMaxDimensionRef=useRef(1120);
  const noDetectionDecodeCountRef=useRef(0);

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

  useEffect(()=>()=>{ stopReceive(); stopPlayback(); if(result?.url) URL.revokeObjectURL(result.url); void wakeLockRef.current?.release().catch(()=>{}); wakeLockRef.current=null; },[result]);

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
    if(!playing) return;
    void setScreenWakeLock(true);
    const onVisibility=()=>{ if(document.visibilityState==='visible' && playing) void setScreenWakeLock(true); };
    document.addEventListener('visibilitychange',onVisibility);
    return()=>document.removeEventListener('visibilitychange',onVisibility);
  },[playing]);

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
            const grid=fountainMode ? (getDisplayLaneCount() === 1 ? 1 : getDisplayLaneCount() === 2 ? 2 : FOUNTAIN_GRID_SIZE) : 1;
            const totalGroups=fountainMode
              ? Math.max(1,Math.ceil((plan as FountainPlan).recommended/grid))
              : Math.max(1,Math.ceil((plan as Awaited<ReturnType<typeof createTransfer>>).total/grid));
            const nextGroup=fountainMode ? playbackGroupRef.current : playbackGroupRef.current % totalGroups;
            const cacheKey=planKey+':'+nextGroup;
            const cached=renderCacheRef.current.get(cacheKey);
            if(cached) {
              drawQrMatricesToCanvas(qrCanvasRef.current,cached.matrices,1400,18);
              playbackGroupRef.current+=1;
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
    const grid=fountainMode ? (getDisplayLaneCount() === 1 ? 1 : getDisplayLaneCount() === 2 ? 2 : FOUNTAIN_GRID_SIZE) : 1;
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
          if(qrCanvasRef.current && !playing) drawQrMatricesToCanvas(qrCanvasRef.current,entry.matrices,1400,18);
          const now=performance.now();
          if(renderWindowStatsRef.current.started===0)renderWindowStatsRef.current.started=now;
          renderWindowStatsRef.current.count+=1;
          renderWindowStatsRef.current.renderMs+=entry.renderMs;
          const windowMs=now-renderWindowStatsRef.current.started;
          if(windowMs>=1500){
            const fps=renderWindowStatsRef.current.count/(windowMs/1000);
            const avgRender=renderWindowStatsRef.current.renderMs/Math.max(1,renderWindowStatsRef.current.count);
            if(autoTune && fountainMode){
              if(avgRender<9 && fps>45 && intervalMs>120)setIntervalMs(v=>Math.max(120,v-2));
              else if(avgRender<16 && fps>30 && intervalMs>140)setIntervalMs(v=>Math.max(140,v-2));
              else if(avgRender>42 && intervalMs<300)setIntervalMs(v=>Math.min(300,v+12));
            }
            renderWindowStatsRef.current={started:now,count:0,renderMs:0};
          }

          const displayGrid=fountainMode ? (getDisplayLaneCount() === 1 ? 1 : getDisplayLaneCount() === 2 ? 2 : FOUNTAIN_GRID_SIZE) : 1;
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
  },[fountain,compat,autoTune,intervalMs,playing]);

  async function startPlayback(){
    const plan=fountain ?? compat;
    if(!plan) return;

    setError('');
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
      if(qrCanvasRef.current) drawQrMatricesToCanvas(qrCanvasRef.current,entry.matrices,1400,18);
      setPlaying(true);
    }catch(error){
      setError(error instanceof Error?error.message:'Unable to start the optical stream.');
    }
  }

  function stopPlayback(){
    setPlaying(false);
    playbackGroupRef.current=0;
    void setScreenWakeLock(false);
    if(timerRef.current!==null){
      window.clearInterval(timerRef.current);
      timerRef.current=null;
    }
    if(playbackRafRef.current!==null){
      window.cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current=null;
    }
    playbackLastAtRef.current=0;
  }
  function stopReceive(){
    receivingRef.current=false;
    detectorRef.current=null;
    streamRef.current?.getTracks().forEach(t=>t.stop());
    streamRef.current=null;
    qrPoolRef.current?.terminate();
    qrPoolRef.current=null;
    if(benchmarkTimerRef.current!==null){window.clearTimeout(benchmarkTimerRef.current);benchmarkTimerRef.current=null;}
    if(fallbackLoopRef.current!==null){window.clearTimeout(fallbackLoopRef.current);fallbackLoopRef.current=null;}
    if(zxingFallbackTimerRef.current!==null){window.clearTimeout(zxingFallbackTimerRef.current);zxingFallbackTimerRef.current=null;}
    fallbackActiveRef.current=false;
    nativeMissRef.current=0;
    nativeSlowRef.current=0;
    setReceiving(false);
    try{ zxingControlsRef.current?.stop(); }catch{}
    zxingControlsRef.current=null;
    zxingReaderRef.current=null;
    if(zxingFallbackTimerRef.current!==null){window.clearTimeout(zxingFallbackTimerRef.current);zxingFallbackTimerRef.current=null;}
  }
  function resetDecoder(){
    fountainDecoderRef.current=null;
    fountainMetaRef.current=null;
    compatibilitySessionRef.current=null;
    recentRef.current.clear();
  }

  async function choose(value?:File){
    if(!value)return;
    setError(''); setResult(null); stopPlayback(); playbackGroupRef.current=0; setGroup(0); resetDecoder(); clearRenderPipeline(); receiverStartedRef.current=null; solvedRef.current=0; decodedBytesRef.current=0; duplicateCountRef.current=0; detectedWindowRef.current={started:0,count:0}; renderWindowRef.current={started:0,count:0};
    try{
      if(mode==='fountain'){
        const plan=await createFountainTransfer(value); setFountain(plan); setCompat(null);
      }else{
        const plan=await createTransfer(value); setCompat(plan); setFountain(null);
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
      setProgress({mode:'multi-image',session:added.id,name:added.name,received:added.received,total:added.total,duplicates:duplicateCountRef.current});
      if(added.complete){
        const rebuilt=await reconstructMultiImage(added.id);
        if(rebuilt){
          if(benchmarking) await finishBenchmarkRun();
          setResult({url:rebuilt.url,name:rebuilt.name,size:rebuilt.size});
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
      if(!fountainDecoderRef.current || sessionChanged){
        fountainMetaRef.current=frame;
        fountainDecoderRef.current=createFountainDecoder(frame);
        solvedRef.current=0;
        decodedBytesRef.current=0;
        setProgress(null);
      }
      const d=fountainDecoderRef.current.add(frame);
      if(d.duplicate)duplicateCountRef.current+=1;
      solvedRef.current=d.solved;
      decodedBytesRef.current=Math.min(frame.size,d.solved*frame.blockBytes);
      setProgress({mode:'fountain',session:frame.session,name:frame.name,received:d.solved,total:frame.blocks,duplicates:duplicateCountRef.current});
      if(d.complete){
        const rebuilt=await fountainDecoderRef.current.reconstruct();
        if(rebuilt){
          if(benchmarking) await finishBenchmarkRun();
          const url=URL.createObjectURL(new Blob([rebuilt.bytes.buffer as ArrayBuffer],{type:frame.mime}));
          setResult({url,name:frame.name,size:frame.size}); setProgress(null); stopReceive();
        }
      }
      return;
    }
    if(isTransferFrame(value)){
      const frame=parseTransferFrame(value); if(!frame)return;
      acceptedTransferFramesRef.current+=1;
      if(compatibilitySessionRef.current && compatibilitySessionRef.current !== frame.session){
        decodedBytesRef.current=0;
        setProgress(null);
      }
      compatibilitySessionRef.current=frame.session;
      const added=await addTransferFrame(frame);
      if(added.duplicate)duplicateCountRef.current+=1;
      decodedBytesRef.current=Math.min(frame.size,Math.round((added.received/added.total)*frame.size));
      setProgress(prev=>({mode:'compatibility',session:frame.session,name:frame.name,received:added.received,total:added.total,duplicates:duplicateCountRef.current}));
      if(added.complete){
        const rebuilt=await reconstructTransfer(frame.session);
        if(rebuilt){if(benchmarking) await finishBenchmarkRun(); setResult({url:rebuilt.url,name:rebuilt.name,size:rebuilt.size});setProgress(null);stopReceive();}
      }
    }
  }

  async function consumeDetected(found:Array<{rawValue?:string}>,decodeMs:number){
    const values=found.map(item=>item.rawValue).filter((value):value is string=>Boolean(value));
    await Promise.all(values.map(value=>processValue(value)));
    recordBenchmark(values,decodeMs);
    return values.length;
  }

  function startFallbackDecoder(){
    if(!receivingRef.current || fallbackActiveRef.current || !videoRef.current) return;
    fallbackActiveRef.current=true;
    detectorRef.current=null;
    nativeMissRef.current=0;
    const canvas=fallbackCanvasRef.current ?? document.createElement('canvas');
    fallbackCanvasRef.current=canvas;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if(!ctx){ setError('Camera fallback decoder could not create an image surface.'); stopReceive(); return; }
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
        // Start below the full camera resolution to keep jsQR responsive on
        // phones. If acquisition fails repeatedly, temporarily raise the
        // decode resolution; once a QR is found, immediately return to the
        // cheaper baseline. This trades idle CPU for extra optical margin.
        const maxDimension=decodeMaxDimensionRef.current;
        const scale=Math.min(1,maxDimension/Math.max(sourceWidth,sourceHeight));
        const width=Math.max(1,Math.round(sourceWidth*scale));
        const height=Math.max(1,Math.round(sourceHeight*scale));
        if(canvas.width!==width)canvas.width=width;
        if(canvas.height!==height)canvas.height=height;
        ctx.imageSmoothingEnabled=false;
        ctx.drawImage(video,0,0,width,height);
        const image=ctx.getImageData(0,0,width,height);

        // Do not serialize camera capture behind a slow QR decode. The pool has
        // multiple workers, so keep feeding fresh frames while workers are busy.
        // This changes the receiver from "one decode at a time" to a pipelined
        // acquisition loop without changing the transfer protocol.
        // Do not spend CPU copying camera frames when every decoder worker is
        // already occupied. Wait for a worker to free up instead.
        if(qrPoolRef.current.available<0){
          fallbackLoopRef.current=window.setTimeout(()=>void loop(),Math.max(18,Math.min(40,scanDelayRef.current)));
          return;
        }
        const job=qrPoolRef.current.decode(image.data.buffer,width,height,1);
        if(job){
          decoderCallsRef.current+=1;
          void job.then(async decoded=>{
            const processStarted=performance.now();
            qrDetectionsRef.current+=decoded.values.length;
            if(decoded.values.length>0){
              lastDetectionRef.current=decoded.values[0].slice(0,48);
              noDetectionDecodeCountRef.current=0;
              decodeMaxDimensionRef.current=1120;
            }else{
              noDetectionDecodeCountRef.current+=1;
              if(noDetectionDecodeCountRef.current>=10){
                decodeMaxDimensionRef.current=1280;
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
                  ?Math.max(28,scanDelayRef.current-3)
                  :Math.min(60,scanDelayRef.current+2);
          }).catch(e=>{
            if(receivingRef.current)setError(e instanceof Error?e.message:'QR decoder worker failed.');
          });
        }
      }

      if(receivingRef.current && fallbackActiveRef.current){
        // 30–60 ms capture cadence feeds both workers and gives the camera
        // several acquisition opportunities during each displayed QR interval.
        fallbackLoopRef.current=window.setTimeout(()=>void loop(),Math.max(30,Math.min(60,scanDelayRef.current)));
      }
    };
    void loop();
  }

  async function scanLoop(){
    if(!receivingRef.current||!videoRef.current||!detectorRef.current)return;
    const started=performance.now();
    let foundCount=0;
    let decodeMs=0;
    try{
      const found=await detectorRef.current.detect(videoRef.current);
      const detectorMs=performance.now()-started;
      decodeMs=detectorMs;
      foundCount=found.length;
      if(detectorMs>450) nativeSlowRef.current+=1;
      else nativeSlowRef.current=0;
      // BarcodeDetector is a progressive enhancement. If this browser takes
      // too long on a real QR, switch immediately to our bounded worker path.
      if(nativeSlowRef.current>=1){ startFallbackDecoder(); return; }
      const processStarted=performance.now();
      await consumeDetected(found,detectorMs);
      const processMs=performance.now()-processStarted;
      if(receivingRef.current){
        setTelemetry(prev=>({...prev,processMs:prev.processMs===0?processMs:prev.processMs*.7+processMs*.3}));
      }
    }catch{
      startFallbackDecoder();
      return;
    }
    // Keep decoder telemetry isolated from IndexedDB/reconstruction work.
    // This makes camera-engine latency directly measurable instead of hiding
    // storage/UI pipeline time inside the displayed decode number.
    const now=performance.now();
    if(receiverStartedRef.current===null)receiverStartedRef.current=started;
    if(detectedWindowRef.current.started===0)detectedWindowRef.current.started=now;
    detectedWindowRef.current.count+=foundCount;
    const windowMs=now-detectedWindowRef.current.started;
    if(windowMs>=500){
      const seconds=windowMs/1000;
      const detectedPerSecond=detectedWindowRef.current.count/seconds;
      const elapsed=Math.max(0.001,(now-(receiverStartedRef.current ?? now))/1000);
      const solvedPerSecond=solvedRef.current/elapsed;
      const goodputKbps=(decodedBytesRef.current/1024)/elapsed;
      setTelemetry(prev=>({...prev,startedAt:receiverStartedRef.current,detectedPerSecond,solvedPerSecond,goodputKbps,duplicates:duplicateCountRef.current,decodeMs:prev.decodeMs===0?decodeMs:prev.decodeMs*0.7+decodeMs*0.3,scanDelayMs:scanDelayRef.current}));
      detectedWindowRef.current={started:now,count:0};
    }
    if(foundCount===0) nativeMissRef.current+=1;
    else nativeMissRef.current=0;
    if(nativeMissRef.current>=4){ startFallbackDecoder(); return; }
    if(decodeMs>60)scanDelayRef.current=Math.min(140,Math.max(scanDelayRef.current,Math.round(decodeMs*0.9)));
    else if(foundCount>0)scanDelayRef.current=Math.max(20,scanDelayRef.current-5);
    else scanDelayRef.current=Math.min(80,scanDelayRef.current+2);
    if(receivingRef.current && !fallbackActiveRef.current)window.setTimeout(()=>void scanLoop(),scanDelayRef.current);
  }

  async function startReceive(){
    setError('');setResult(null);setProgress(null);resetDecoder();
    receiverStartedRef.current=null;solvedRef.current=0;duplicateCountRef.current=0;
    detectedWindowRef.current={started:0,count:0};scanDelayRef.current=55;
    cameraFramesRef.current=0;decoderCallsRef.current=0;qrDetectionsRef.current=0;acceptedTransferFramesRef.current=0;lastDetectionRef.current='—';telemetryTickRef.current=0;
    decodeMaxDimensionRef.current=1120;
    noDetectionDecodeCountRef.current=0;
    nativeMissRef.current=0;nativeSlowRef.current=0;fallbackActiveRef.current=false;
    setTelemetry(prev=>({...prev,startedAt:null,detectedPerSecond:0,solvedPerSecond:0,goodputKbps:0,duplicates:0,decodeMs:0,processMs:0,scanDelayMs:55,cameraFrames:0,decoderCalls:0,qrDetections:0,transferFrames:0,lastDetection:'—'}));

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
          frameRate:{ideal:30,max:30},
        },
        audio:false,
      });
      streamRef.current=stream;receivingRef.current=true;setReceiving(true);
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
      startFallbackDecoder();
    }catch(e){
      stopReceive();
      setError(e instanceof Error?e.message:'Camera permission was denied.');
    }
  }

  return <section className="transfer-page mx-auto max-w-6xl py-8 sm:py-12">
    <Link to="/" className="text-xs font-semibold text-[var(--text-muted)]">Back home</Link>
    <div className="mt-5 overflow-hidden rounded-[32px] border border-cyan-300/15 bg-[var(--bg-elevated)] p-6 shadow-glass backdrop-blur-2xl sm:p-9">
      <div className="flex flex-wrap gap-2"><span className="inline-flex items-center gap-2 rounded-full border border-cyan-300/15 bg-cyan-300/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[.18em] text-cyan-200"><Radio size={14}/> OptiTransfer 2.0</span><span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300"><WifiOff size={14}/> Offline optical</span></div>
      <h1 className="mt-5 text-4xl font-black tracking-[-.045em] sm:text-6xl">Fast file transfer <span className="text-gradient">without internet.</span></h1>
      <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--text-muted)] sm:text-base">MVP first: a reliable phone-to-phone optical file transfer. Start at a camera-friendly frame cadence, recover dropped/duplicated/out-of-order frames with fountain coding, then verify the reconstructed bytes with SHA-256. Speed modes come after the transfer path is proven.</p>
    </div>

    <div className="transfer-tabs mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-1">
      <button onClick={()=>{stopReceive();setTab('send')}} className={`rounded-xl px-4 py-3 text-sm font-bold ${tab==='send'?'bg-white text-slate-950':'text-[var(--text-muted)]'}`}><FileUp size={15} className="mr-2 inline"/>Send</button>
      <button onClick={()=>setTab('receive')} className={`rounded-xl px-4 py-3 text-sm font-bold ${tab==='receive'?'bg-white text-slate-950':'text-[var(--text-muted)]'}`}><ScanLine size={15} className="mr-2 inline"/>Receive</button>
    </div>

    {tab==='send' ? <div className="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
      <div className="glass-panel rounded-[28px] p-5">
        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white/5 p-1">
          <button onClick={()=>{stopPlayback();setMode('fountain');setFountain(null);setCompat(null);setFile(null);}} className={`rounded-xl px-3 py-3 text-xs font-bold ${mode==='fountain'?'bg-cyan-300 text-slate-950':'text-[var(--text-muted)]'}`}>Fountain speed</button>
          <button onClick={()=>{stopPlayback();setMode('compatibility');setFountain(null);setCompat(null);setFile(null);}} className={`rounded-xl px-3 py-3 text-xs font-bold ${mode==='compatibility'?'bg-white text-slate-950':'text-[var(--text-muted)]'}`}>Compatibility</button>
        </div>
        <input ref={inputRef} type="file" className="sr-only" onChange={e=>{void choose(e.target.files?.[0]);e.currentTarget.value='';}}/>
        <button onClick={()=>inputRef.current?.click()} className="mt-4 w-full rounded-[24px] border border-dashed border-cyan-300/30 bg-cyan-300/[.05] p-8 text-center"><FileUp className="mx-auto text-cyan-300" size={30}/><p className="mt-3 font-bold">Choose any file</p><p className="mt-1 text-xs text-[var(--text-muted)]">{mode==='fountain'?'Up to 64 MB · fountain recovery':'Up to 100 MB · exact sequential recovery'}</p></button>
        <button onClick={()=>{const bytes=new Uint8Array(1024*1024);for(let i=0;i<bytes.length;i+=1)bytes[i]=(i*73+(i%251)*29+(i>>>8))&255;void choose(new File([bytes],'opticode-1mb-benchmark.bin',{type:'application/octet-stream'}));}} className="mt-3 w-full rounded-2xl border border-cyan-300/15 bg-white/5 p-3 text-left"><p className="text-xs font-black text-cyan-200">Canonical 1 MB benchmark fixture</p><p className="mt-1 text-[10px] leading-5 text-[var(--text-muted)]">Deterministic 1,048,576-byte payload for comparable screen-to-camera measurements.</p></button>
        {file&&<div className="mt-4 rounded-2xl bg-white/5 p-4"><p className="truncate font-bold">{file.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{(file.size/1024/1024).toFixed(2)} MB · {mode==='fountain'?`${fountain?.blocks.toLocaleString()} source blocks`:`${compat?.total.toLocaleString()} QR frames`}</p></div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-white/5 p-4"><Gauge size={18} className="text-cyan-300"/><p className="mt-2 text-sm font-bold">High-speed stream</p><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">Adaptive 1/2/4 QR lanes sized for the sender display, with continuous recovery.</p></div>
          <div className="rounded-2xl bg-white/5 p-4"><ShieldCheck size={18} className="text-emerald-300"/><p className="mt-2 text-sm font-bold">Integrity verified</p><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">The completed file must match the original SHA-256 hash.</p></div>
        </div>
      </div>
      <div className="glass-panel rounded-[28px] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-cyan-300">Live optical stream</p><p className="mt-1 text-sm text-[var(--text-muted)]">{fountain?'MVP fountain stream · systematic + recovery droplets':compat?'Sequential compatibility stream':'Choose a file to begin'}</p></div>{(fountain||compat)&&<button onClick={()=>{if(playing)stopPlayback();else void startPlayback();}} className="rounded-full bg-white px-4 py-2 text-xs font-black text-slate-950">{playing?'Pause':'Start stream'}</button>}</div>
        {(fountain||compat)?<canvas ref={qrCanvasRef} width={900} height={900} aria-label="OptiTransfer QR stream" className="transfer-canvas mx-auto mt-5 aspect-square w-full max-w-[760px] min-h-[min(72vh,760px)] rounded-2xl bg-white p-1 sm:p-2"/>:<div className="mt-5 grid aspect-square place-items-center rounded-2xl bg-black/20 text-sm text-[var(--text-muted)]">QR stream preview</div>}
        {(fountain||compat)&&<div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="rounded-xl bg-white/5 p-3 text-xs font-bold">Auto tune<select value={autoTune?'on':'off'} onChange={e=>setAutoTune(e.target.value==='on')} className="mt-2 w-full rounded-lg bg-black/20 p-2 text-xs"><option value="on">On · render-safe</option><option value="off">Off · manual</option></select></label><label className="rounded-xl bg-white/5 p-3 text-xs font-bold">Speed<select value={intervalMs} onChange={e=>setIntervalMs(Number(e.target.value))} className="mt-2 w-full rounded-lg bg-black/20 p-2 text-xs"><option value="500">500 ms · slow reliable</option><option value="700">700 ms · MVP default</option><option value="1000">1000 ms · maximum acquisition margin</option></select></label><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Engine</b><p className="mt-1 text-[var(--text-muted)]">{telemetry.encoderWorkers>0?telemetry.encoderWorkers+' worker encoder':'main-thread fallback'} · {telemetry.prefetchReady}/6 groups ready</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Render</b><p className="mt-1 text-[var(--text-muted)]">{telemetry.renderMs.toFixed(1)} ms · QR encode {telemetry.encodeMs.toFixed(1)} ms</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Payload</b><p className="mt-1 text-[var(--text-muted)]">{fountain?FOUNTAIN_BLOCK_BYTES+' bytes/block':'525 raw bytes/frame'}</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Display lanes</b><p className="mt-1 text-[var(--text-muted)]">{getDisplayLaneCount()} QR code{getDisplayLaneCount() === 1 ? "" : "s"} · MVP keeps mobile transfer at one physical lane</p></div><div className="rounded-xl bg-white/5 p-3 text-xs"><b>Recovery</b><p className="mt-1 text-[var(--text-muted)]">{fountain?'Fountain':'Sequential'}</p></div></div>}
      </div>
    </div> : <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_.8fr]">
      <div className="transfer-camera glass-panel overflow-hidden rounded-[28px] p-4"><video ref={videoRef} muted playsInline className="h-[min(72vh,720px)] min-h-[480px] w-full rounded-2xl bg-black object-cover sm:min-h-[560px]"/><div className="mt-3 flex flex-wrap gap-2"><button onClick={()=>{if(receiving)stopReceive();else void startReceive();}} className="rounded-full bg-white px-4 py-2 text-sm font-black text-slate-950">{receiving?'Stop receiver':'Start receiver'}</button><span className="rounded-full bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-300">{receiving?'Scanning multi-QR':'Camera idle'}</span>{receiving&&<button onClick={startBenchmark} className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-bold text-cyan-200">{benchmarking?'Benchmarking…':'Benchmark 1 MB'}</button>}</div></div>
      <div className="transfer-receiver-panel glass-panel rounded-[28px] p-5"><LockKeyhole size={20} className="text-cyan-300"/><p className="mt-3 font-bold">Loss-tolerant receiver</p><p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">MVP receiver uses a continuous camera-frame worker immediately. It reports camera frames, decoder calls, QR hits, and accepted ORX1 frames separately so failures are diagnosable.</p><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-2xl bg-cyan-300/[.06] p-3"><Activity size={16} className="text-cyan-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Camera</p><p className="mt-1 text-sm font-black">{telemetry.cameraFrames}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">video frames</p></div>
          <div className="rounded-2xl bg-cyan-300/[.06] p-3"><ScanLine size={16} className="text-cyan-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">QR hits</p><p className="mt-1 text-sm font-black">{telemetry.qrDetections}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{telemetry.detectedPerSecond.toFixed(1)}/s</p></div>
          <div className="rounded-2xl bg-white/5 p-3"><TimerReset size={16} className="text-white/70"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Decoder</p><p className="mt-1 text-sm font-black">{telemetry.decodeMs.toFixed(0)} ms</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{telemetry.decoderCalls} calls · {Math.round(telemetry.scanDelayMs)} ms cadence</p></div>
          <div className="rounded-2xl bg-white/5 p-3"><ShieldCheck size={16} className="text-emerald-300"/><p className="mt-2 text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">ORX1 accepted</p><p className="mt-1 text-sm font-black">{telemetry.transferFrames}</p><p className="mt-1 truncate text-[10px] text-[var(--text-muted)]">{telemetry.lastDetection}</p></div>
        </div>
        <div className="mt-3 rounded-2xl bg-white/5 p-3 text-[10px] leading-5 text-[var(--text-muted)]"><span className="font-bold text-white/80">Acquisition:</span> camera {telemetry.cameraFrames>0?'✓':'…'} → decoder {telemetry.decoderCalls>0?'✓':'…'} → QR {telemetry.qrDetections>0?'✓':'…'} → ORX1 {telemetry.transferFrames>0?'✓':'…'} · last: {telemetry.lastDetection}</div>
        {benchmark&&<div className="mt-5 rounded-2xl border border-cyan-300/15 bg-cyan-300/[.05] p-4"><div className="flex items-center justify-between gap-2"><p className="text-xs font-bold uppercase tracking-[.14em] text-cyan-200">Physical 1 MB benchmark</p><span className="text-[10px] text-[var(--text-muted)]">{(benchmark.durationMs/1000).toFixed(1)} s</span></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><p className="text-[10px] text-[var(--text-muted)]">Sustained</p><p className="text-sm font-black">{benchmark.goodputKbps.toFixed(1)} KB/s</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Peak ≥1s</p><p className="text-sm font-black">{benchmark.peakGoodputKbps.toFixed(1)} KB/s</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Codes/sec</p><p className="text-sm font-black">{benchmark.sustainedDecodeRate.toFixed(1)} / {benchmark.peakDecodeRate.toFixed(1)}</p></div><div><p className="text-[10px] text-[var(--text-muted)]">Unique codes</p><p className="text-sm font-black">{benchmark.uniqueCodes}</p></div></div><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl bg-white/5 p-3"><p className="text-[10px] text-[var(--text-muted)]">Decimen desktop→phone reference</p><p className="mt-1 text-xs font-bold">418.5 KB/s sustained · 601.5 KB/s peak</p></div><div className="rounded-xl bg-white/5 p-3"><p className="text-[10px] text-[var(--text-muted)]">Decimen phone→phone reference</p><p className="mt-1 text-xs font-bold">199.2 KB/s sustained · 340.8 KB/s peak</p></div></div><p className="mt-3 text-[10px] leading-5 text-[var(--text-muted)]">Run this on the actual device pair. The result is a measurement, not a simulated claim. To establish a “better than Decimen” result, repeat the same 1 MB, 10-second methodology on a comparable device pair and compare sustained and ≥1-second peak goodput.</p></div>}{progress&&<div className="mt-5 rounded-2xl bg-white/5 p-4"><p className="truncate text-sm font-bold">{progress.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{progress.mode==='fountain'?`${progress.received.toLocaleString()} unique droplets · ${progress.total.toLocaleString()} source blocks`:progress.mode==='multi-image'?`${progress.received} / ${progress.total} image frames`:`${progress.received} / ${progress.total} frames`}</p><div className="mt-3 h-2 rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all" style={{width:`${Math.min(100,Math.round(progress.received/progress.total*100))}%`}}/></div></div>}{result&&<div className="mt-5 rounded-2xl bg-emerald-400/10 p-4"><CheckCircle2 className="text-emerald-300"/><p className="mt-2 font-bold">File reconstructed & verified</p><p className="mt-1 truncate text-xs text-[var(--text-muted)]">{result.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{(result.size/1024/1024).toFixed(2)} MB · SHA-256 verified</p><a href={result.url} download={result.name} className="mt-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-950"><Download size={14}/> Save file</a></div>}{error&&<p className="mt-5 rounded-2xl bg-rose-400/10 p-4 text-sm text-rose-200">{error}</p>}</div>
    </div>}
    <div className="mt-5 grid gap-3 md:grid-cols-3">{[['01','Encode','The file becomes source blocks and optical droplets.'],['02','Stream','The MVP sender uses one optical lane; multi-lane transport is reserved for the optimization phase.'],['03','Recover','Missing frames are tolerated and SHA-256 verifies the result.']].map(([n,t,d])=><div key={n} className="glass-panel rounded-[24px] p-5"><span className="text-xs font-black text-cyan-300">{n}</span><h2 className="mt-2 font-bold">{t}</h2><p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">{d}</p></div>)}</div>
  </section>;
}
