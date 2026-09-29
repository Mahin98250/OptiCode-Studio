import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Camera, CameraOff, CheckCircle2, Copy, Crosshair, Download, FlaskConical, Maximize2, Minimize2, Pause, Play, RotateCcw, ScanLine, Timer, Upload, Zap } from 'lucide-react';
import { GlassCard } from '../../components/ui/GlassCard';
import { GlassButton } from '../../components/ui/GlassButton';
import { decodeOptiFrame, decodeOptiFramePerspective, encodeOptiFrame, getOptiFrameCapacity, inspectOptiFrameAcquisition, OPTIFRAME_SIZE, type OptiFrameAcquisitionDiagnostics, type OptiFramePerspectiveDiagnostics } from '../../lib/optiframe';
import { OptiFrameAssembler, splitOptiFramePayload, utf8ToText } from '../../lib/optiframeStream';
import { OptiFrameDecodePool } from '../../lib/optiframeDecodePool';
import { createAdaptiveTransmission } from '../../lib/adaptiveTransmission';
import { createOptiFrameCanvasCache, createOptiLaneSurface, cropOptiLaneGrid, type OptiLaneCount } from '../../lib/optiframeLanes';
import { createOptiCodeFileTransfer, decodeOptiCodeFileTransfer, type OptiCodeFileTransfer } from '../../lib/opticodeTransfer';

type CameraStats = {
  attempts: number;
  hits: number;
  duplicates: number;
  dropped: number;
  workerHits: number;
  localHits: number;
  lastMs: number;
  bytes: number;
  captureFps: number;
  decodeFps: number;
  goodputBps: number;
  lastConfidence: number;
  cameraWidth: number;
  cameraHeight: number;
  cameraFrameRate: number;
  startedAt: number | null;
};


type OptiVideoCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  resizeMode?: string[];
};

type OptiVideoConstraintSet = MediaTrackConstraintSet & {
  focusMode?: ConstrainDOMString;
  resizeMode?: ConstrainDOMString;
};

type OptiVideoTrackConstraints = MediaTrackConstraints & {
  focusMode?: ConstrainDOMString;
  resizeMode?: ConstrainDOMString;
  advanced?: OptiVideoConstraintSet[];
};

type AcquisitionTestStageCounts = Record<OptiFrameAcquisitionDiagnostics['stage'], number>;

type AcquisitionTestState = {
  running: boolean;
  samples: number;
  locks: number;
  totalCorners: number;
  averageMs: number;
  peakMs: number;
  lastStage: OptiFrameAcquisitionDiagnostics['stage'];
  stageCounts: AcquisitionTestStageCounts;
};

const ACQUISITION_TEST_SAMPLES = 30;

function emptyAcquisitionStageCounts(): AcquisitionTestStageCounts {
  return {
    image: 0,
    searching: 0,
    anchors: 0,
    geometry: 0,
    calibration: 0,
    ready: 0,
  };
}

function emptyAcquisitionTest(): AcquisitionTestState {
  return {
    running: false,
    samples: 0,
    locks: 0,
    totalCorners: 0,
    averageMs: 0,
    peakMs: 0,
    lastStage: 'image',
    stageCounts: emptyAcquisitionStageCounts(),
  };
}

export function OptiFrameLab() {
  const [text, setText] = useState('OptiCode experimental optical stream');
  const [seq, setSeq] = useState(0);
  const [total, setTotal] = useState(1);
  const [image, setImage] = useState('');
  const [decoded, setDecoded] = useState('');
  const [status, setStatus] = useState('Generate a frame to begin.');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraDecoded, setCameraDecoded] = useState('');
  const [receiver, setReceiver] = useState({ total: 0, received: 0, bytes: 0, missing: [] as number[], complete: false });
  const [cameraStats, setCameraStats] = useState<CameraStats>({ attempts: 0, hits: 0, duplicates: 0, dropped: 0, workerHits: 0, localHits: 0, lastMs: 0, bytes: 0, captureFps: 0, decodeFps: 0, goodputBps: 0, lastConfidence: 0, cameraWidth: 0, cameraHeight: 0, cameraFrameRate: 0, startedAt: null });
  const [acquisition, setAcquisition] = useState<OptiFrameAcquisitionDiagnostics>({ stage: 'image', anchors: [], confidence: 0, moduleScale: 0, angle: 0, geometryRatio: 0, sampleWidth: 0, sampleHeight: 0, elapsedMs: 0 });
  const [cameraCapabilities, setCameraCapabilities] = useState<string[]>([]);
  const [acquisitionTest, setAcquisitionTest] = useState<AcquisitionTestState>(emptyAcquisitionTest);
  const [opticalDisplayMode, setOpticalDisplayMode] = useState(false);
  const [streamPlaying, setStreamPlaying] = useState(false);
  const [streamIndex, setStreamIndex] = useState(0);
  const [laneCount, setLaneCount] = useState<OptiLaneCount>(1);
  const [streamIntervalMs, setStreamIntervalMs] = useState(300);
  const [transferFile, setTransferFile] = useState<File | null>(null);
  const [transferData, setTransferData] = useState<Uint8Array | null>(null);
  const [receivedFile, setReceivedFile] = useState<OptiCodeFileTransfer | null>(null);
  const [receivedFileUrl, setReceivedFileUrl] = useState('');

  const capacity = useMemo(() => getOptiFrameCapacity(), []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const senderTimerRef = useRef<number | null>(null);
  const assemblerRef = useRef(new OptiFrameAssembler());
  const decodePoolRef = useRef(new OptiFrameDecodePool());
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const presentationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const seenSequenceRef = useRef(new Set<number>());
  const trackedAnchorsRef = useRef<OptiFramePerspectiveDiagnostics['anchors'] | null>(null);
  const framesSinceFullScanRef = useRef(0);
  const acquisitionFailureRef = useRef(0);
  const acquisitionTestRef = useRef(false);
  const acquisitionTestMetricsRef = useRef(emptyAcquisitionTest());
  const reacquireEveryFrames = 12;
  const receivedFileUrlRef = useRef('');
  const streamFrameCacheRef = useRef(createOptiFrameCanvasCache(96));
  const adaptiveTransmissionRef = useRef(createAdaptiveTransmission(80));

  const streamPayload = useMemo(() => {
    const payload = transferData ?? new TextEncoder().encode(text);
    return splitOptiFramePayload(payload, capacity);
  }, [text, transferData, capacity]);

  useEffect(() => {
    return () => {
      stopCamera();
      decodePoolRef.current.terminate();
      if (receivedFileUrlRef.current) URL.revokeObjectURL(receivedFileUrlRef.current);
    };
  }, []);

  useEffect(() => {
    streamFrameCacheRef.current.clear();
  }, [streamPayload]);

  useEffect(() => {
    setStreamIndex(index => {
      const length = Math.max(1, streamPayload.length);
      const group = Math.floor(index / laneCount);
      return (group * laneCount) % length;
    });
  }, [streamPayload.length, laneCount]);

  useEffect(() => {
    if (!streamPlaying) {
      adaptiveTransmissionRef.current.reset(streamIntervalMs);
      return;
    }
    senderTimerRef.current = window.setInterval(() => {
      setStreamIndex(index => (index + laneCount) % Math.max(1, streamPayload.length));
    }, streamIntervalMs);
    return () => {
      if (senderTimerRef.current !== null) window.clearInterval(senderTimerRef.current);
      senderTimerRef.current = null;
    };
  }, [streamPlaying, streamPayload.length, laneCount, streamIntervalMs]);

  const streamSurface = useMemo(() => {
    try {
      const payloads = Array.from({ length: laneCount }, (_, lane) =>
        streamPayload[(streamIndex + lane) % Math.max(1, streamPayload.length)] ?? new Uint8Array(),
      );
      return createOptiLaneSurface(payloads, streamIndex, Math.max(1, streamPayload.length), laneCount, streamFrameCacheRef.current).canvas;
    } catch {
      return null;
    }
  }, [streamPayload, streamIndex, laneCount]);

  useEffect(() => {
    const drawSurface = (target: HTMLCanvasElement | null) => {
      if (!target || !streamSurface) return 0;
      const started = performance.now();
      target.width = streamSurface.width;
      target.height = streamSurface.height;
      const ctx = target.getContext('2d');
      if (!ctx) return 0;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(streamSurface, 0, 0);
      return performance.now() - started;
    };

    const renderMs = Math.max(
      drawSurface(streamCanvasRef.current),
      drawSurface(presentationCanvasRef.current),
    );

    if (streamPlaying && renderMs > 0) {
      const decision = adaptiveTransmissionRef.current.observe({ renderMs });
      if (decision.changed && decision.intervalMs !== streamIntervalMs) {
        setStreamIntervalMs(decision.intervalMs);
        setStatus(
          'Adaptive display cadence · ' +
          decision.intervalMs +
          ' ms · ' +
          decision.direction +
          ' to match rendering load.',
        );
      }
    }
  }, [streamSurface, streamPlaying, streamIntervalMs]);

  function generate() {
    try {
      const payload = new TextEncoder().encode(text);
      const out = encodeOptiFrame(payload, seq, total);
      setImage(out.canvas.toDataURL('image/png'));
      setDecoded('');
      setStatus(`Encoded frame ${seq + 1}/${total}; 4 luminance levels, 2-bit symbols and CRC-32.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to encode frame.');
    }
  }

  async function load(file?: File) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setStatus('Loading image…');
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.decoding = 'async';
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('Unable to read that image.'));
        element.src = url;
      });

      // MVP upload path: never run the expensive camera-style finder search on
      // the original photo. Bound the bitmap first, then try deterministic decode.
      const maxSide = 768;
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas unavailable.');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, width, height);
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));

      // MVP upload mode is intentionally deterministic: decode a straight,
      // generated 1× frame only. Camera perspective recovery remains a separate
      // live path, so a bad upload can never trigger the expensive finder search.
      const out = decodeOptiFrame(canvas);
      if (!out) throw new Error('Rejected: this MVP upload expects a clear, straight OptiFrame image. Generate a frame here and upload that PNG.');
      setDecoded(utf8ToText(out.payload));
      setStatus('Decoded frame ' + (out.sequence + 1) + '/' + out.total + '; CRC-32 verified.');
      canvas.width = 1;
      canvas.height = 1;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to decode frame.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function save() {
    if (!image) return;
    const link = document.createElement('a');
    link.href = image;
    link.download = 'optiframe.png';
    link.click();
  }

  async function copy() {
    if (decoded && navigator.clipboard) await navigator.clipboard.writeText(decoded);
  }

  function stopCamera() {
    acquisitionTestRef.current = false;
    setAcquisitionTest(previous => ({ ...previous, running: false }));
    if (loopRef.current !== null) {
      window.clearTimeout(loopRef.current);
      loopRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  async function selectTransferFile(file?: File) {
    if (!file) return;
    try {
      setStatus('Preparing ' + file.name + ' for optical transfer…');
      const payload = await createOptiCodeFileTransfer(file);
      setTransferFile(file);
      setTransferData(payload);
      setStreamIndex(0);
      setStreamPlaying(false);
      setStatus(file.name + ' ready · ' + file.size.toLocaleString() + ' bytes · ' + Math.max(1, Math.ceil(payload.length / capacity)) + ' optical frames.');
    } catch (error) {
      setTransferFile(null);
      setTransferData(null);
      setStatus(error instanceof Error ? error.message : 'Unable to prepare that file.');
    }
  }

  function clearTransferFile() {
    setTransferFile(null);
    setTransferData(null);
    setStreamPlaying(false);
    setStreamIndex(0);
    setStatus('File cleared. Text mode is active.');
  }

  function finishReceivedPayload(payload: Uint8Array) {
    const fileTransfer = decodeOptiCodeFileTransfer(payload);
    if (fileTransfer) {
      if (receivedFileUrlRef.current) URL.revokeObjectURL(receivedFileUrlRef.current);
      const url = URL.createObjectURL(new Blob([fileTransfer.data.slice().buffer], { type: fileTransfer.type }));
      receivedFileUrlRef.current = url;
      setReceivedFile(fileTransfer);
      setReceivedFileUrl(url);
      setCameraDecoded('');
      setStatus('Transfer complete · ' + fileTransfer.name + ' · ' + fileTransfer.size.toLocaleString() + ' bytes.');
      return;
    }
    setReceivedFile(null);
    setReceivedFileUrl('');
    setCameraDecoded(utf8ToText(payload));
  }

  async function decodeCameraFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !streamRef.current) return;

    const capture = captureCanvasRef.current ?? document.createElement('canvas');
    captureCanvasRef.current = capture;
    // Preserve more camera detail for small optical cells. The display surface
    // is now rendered at 3× protocol resolution, so downscaling to 720 px would
    // throw away exactly the pixels we need for reliable finder/anchor detection.
    const maxDimension = 1440;
    const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (capture.width !== width) capture.width = width;
    if (capture.height !== height) capture.height = height;
    const context = capture.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);

    const captureStarted = performance.now();

    if (acquisitionTestRef.current) {
      const probe = inspectOptiFrameAcquisition(image);
      const elapsed = performance.now() - captureStarted;
      const previous = acquisitionTestMetricsRef.current;
      const stageCounts = { ...previous.stageCounts, [probe.stage]: previous.stageCounts[probe.stage] + 1 };
      const samples = previous.samples + 1;
      const locks = previous.locks + (probe.stage === 'ready' ? 1 : 0);
      const next: AcquisitionTestState = {
        running: samples < ACQUISITION_TEST_SAMPLES,
        samples,
        locks,
        totalCorners: previous.totalCorners + probe.anchors.length,
        averageMs: ((previous.averageMs * previous.samples) + elapsed) / samples,
        peakMs: Math.max(previous.peakMs, elapsed),
        lastStage: probe.stage,
        stageCounts,
      };
      acquisitionTestMetricsRef.current = next;
      setAcquisitionTest(next);
      setAcquisition(probe);
      if (samples >= ACQUISITION_TEST_SAMPLES) {
        acquisitionTestRef.current = false;
        setStatus(
          'Camera test complete · ' +
          Math.round((locks / samples) * 100) +
          '% full-lock rate · ' +
          Math.round((next.totalCorners / samples) * 10) / 10 +
          ' anchors/sample · ' +
          next.averageMs.toFixed(0) +
          ' ms mean',
        );
      } else {
        setStatus('Camera test ' + samples + '/' + ACQUISITION_TEST_SAMPLES + ' · ' + probe.stage.toUpperCase());
      }
      return;
    }

    const cropTrackedRegion = (source: ImageData) => {
      const anchors = trackedAnchorsRef.current;
      if (!anchors) return null;
      const minX = Math.min(...anchors.map(anchor => anchor.x));
      const maxX = Math.max(...anchors.map(anchor => anchor.x));
      const minY = Math.min(...anchors.map(anchor => anchor.y));
      const maxY = Math.max(...anchors.map(anchor => anchor.y));
      const scale = anchors.reduce((sum, anchor) => sum + anchor.scale, 0) / anchors.length;
      const padding = Math.max(18, scale * 12);
      const side = Math.ceil(Math.max(maxX - minX, maxY - minY) + padding * 2);
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const x = Math.max(0, Math.min(source.width - side, Math.round(centerX - side / 2)));
      const y = Math.max(0, Math.min(source.height - side, Math.round(centerY - side / 2)));
      const width = Math.min(side, source.width - x);
      const height = Math.min(side, source.height - y);
      if (width < OPTIFRAME_SIZE || height < OPTIFRAME_SIZE) return null;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const imageData = new ImageData(width, height);
      for (let row = 0; row < height; row += 1) {
        const srcStart = ((y + row) * source.width + x) * 4;
        imageData.data.set(source.data.subarray(srcStart, srcStart + width * 4), row * width * 4);
      }
      return { image: imageData, offsetX: x, offsetY: y };
    };

    const runWorker = async (target: ImageData) => {
      const job = decodePoolRef.current.decode(target.data.buffer.slice(0), target.width, target.height);
      if (!job) return { result: null as Awaited<ReturnType<OptiFrameDecodePool['decode']>>, dropped: true, failed: false };
      try {
        return { result: await job, dropped: false, failed: false };
      } catch {
        return { result: null as Awaited<ReturnType<OptiFrameDecodePool['decode']>>, dropped: false, failed: true };
      }
    };

    const runLocal = (target: ImageData) => {
      try {
        return decodeOptiFramePerspective(target);
      } catch {
        return null;
      }
    };

    const runWorkerWithBoundedFallback = async (target: ImageData) => {
      const capacityBefore = decodePoolRef.current.capacity;
      const worker = await runWorker(target);
      if (worker.result) return worker;

      // A normal worker decode miss is not a worker failure. Only fall back
      // when the pool has actually lost capacity (or started with none).
      // This keeps the main thread off the hot path while still preserving
      // camera functionality on browsers that cannot keep workers alive.
      const capacityAfter = decodePoolRef.current.capacity;
      const workerUnavailable = capacityAfter === 0 || capacityAfter < capacityBefore;
      const local = workerUnavailable ? runLocal(target) : null;
      return {
        result: local ? { frame: local.frame, diagnostics: local.diagnostics } : null,
        dropped: worker.dropped,
        failed: worker.failed,
      };
    };

    let workerResult: Awaited<ReturnType<OptiFrameDecodePool['decode']>> = null;
    let result: ReturnType<typeof decodeOptiFramePerspective> = null;
    let cropOffset = { x: 0, y: 0 };
    let usedTrackedCrop = false;
    let usedFullScan = false;
    let dropped = false;

    if (laneCount > 1) {
      const lanes = cropOptiLaneGrid(image, laneCount);
      if (lanes.length !== laneCount) {
        setCameraStats(prev => ({ ...prev, attempts: prev.attempts + 1, dropped: prev.dropped + laneCount }));
        return;
      }

      // Queue the entire lane set through the bounded worker scheduler.
      // This prevents lanes from being discarded just because the pool has
      // fewer workers than the selected optical grid.
      const workerResults = await decodePoolRef.current.decodeBatch(
        lanes.map(lane => ({
          buffer: lane.image.data.buffer.slice(0),
          width: lane.image.width,
          height: lane.image.height,
        })),
      );

      const laneResults = lanes.map((lane, index) => {
        const worker = workerResults[index] ?? null;
        const result = worker
          ? { frame: worker.frame, diagnostics: worker.diagnostics }
          : null;
        return { lane, result, worker };
      });
      const successes = laneResults.filter(entry => entry.result);
      const elapsed = performance.now() - captureStarted;
      const failedLanes = laneResults.length - successes.length;

      if (successes.length === 0) {
        setCameraStats(prev => ({
          ...prev,
          attempts: prev.attempts + 1,
          dropped: prev.dropped + failedLanes,
          lastMs: elapsed,
        }));
        return;
      }

      if (successes.some(entry => entry.result?.frame.sequence === 0) && receiver.complete) {
        seenSequenceRef.current.clear();
        assemblerRef.current.reset();
      }

      let assembly = {
        total: receiver.total,
        received: receiver.received,
        bytes: receiver.bytes,
        missing: receiver.missing,
        complete: receiver.complete,
      } as ReturnType<OptiFrameAssembler['add']>;
      let duplicateCount = 0;
      let workerCount = 0;
      let localCount = 0;

      for (const entry of successes) {
        const result = entry.result;
        if (!result) continue;
        if (entry.worker) workerCount += 1;
        else localCount += 1;
        if (seenSequenceRef.current.has(result.frame.sequence)) duplicateCount += 1;
        assembly = assemblerRef.current.add(result.frame);
        seenSequenceRef.current.add(result.frame.sequence);
      }

      const elapsedFromStart = cameraStats.startedAt ? Math.max(0.001, (performance.now() - cameraStats.startedAt) / 1000) : 0;
      setCameraStats(prev => ({
        ...prev,
        attempts: prev.attempts + 1,
        hits: prev.hits + successes.length,
        duplicates: prev.duplicates + duplicateCount,
        workerHits: prev.workerHits + workerCount,
        localHits: prev.localHits + localCount,
        dropped: prev.dropped + failedLanes,
        lastMs: elapsed,
        captureFps: elapsedFromStart ? (prev.attempts + 1) / elapsedFromStart : 0,
        decodeFps: elapsedFromStart ? (prev.hits + successes.length) / elapsedFromStart : 0,
        bytes: assembly.bytes,
        goodputBps: elapsedFromStart ? assembly.bytes / elapsedFromStart : 0,
        lastConfidence: successes.reduce((sum, entry) => sum + (entry.result?.diagnostics.confidence ?? 0), 0) / successes.length,
      }));

      setReceiver({
        total: assembly.total,
        received: assembly.received,
        bytes: assembly.bytes,
        missing: assembly.missing.slice(0, 40),
        complete: assembly.complete,
      });

      setStatus(`Multi-lane ${successes.length}/${laneCount} decoded · ${assembly.received}/${assembly.total || 0} frames · ${workerCount} worker / ${localCount} local · ${elapsed.toFixed(0)} ms capture-decode`);

      if (assembly.complete && assembly.payload) {
        finishReceivedPayload(assembly.payload);
      }
      return;
    }
    const trackedCrop = cropTrackedRegion(image);
    const shouldFullScan = !trackedCrop || framesSinceFullScanRef.current >= reacquireEveryFrames;
    if (trackedCrop && !shouldFullScan) {
      usedTrackedCrop = true;
      const worker = await runWorkerWithBoundedFallback(trackedCrop.image);
      workerResult = worker.result && !worker.failed && !worker.dropped
        ? worker.result as Awaited<ReturnType<OptiFrameDecodePool['decode']>>
        : null;
      dropped = worker.dropped;
      result = worker.result;
      cropOffset = { x: trackedCrop.offsetX, y: trackedCrop.offsetY };
    }

    if (!result) {
      usedFullScan = true;
      const worker = await runWorkerWithBoundedFallback(image);
      workerResult = worker.result && !worker.failed && !worker.dropped
        ? worker.result as Awaited<ReturnType<OptiFrameDecodePool['decode']>>
        : null;
      dropped = dropped || worker.dropped;
      result = worker.result;
      cropOffset = { x: 0, y: 0 };
    }

    if (result) {
      framesSinceFullScanRef.current = usedFullScan ? 0 : framesSinceFullScanRef.current + 1;
      acquisitionFailureRef.current = 0;
      const absoluteAnchors = result.diagnostics.anchors.map(anchor => ({
        ...anchor,
        x: anchor.x + cropOffset.x,
        y: anchor.y + cropOffset.y,
      })) as OptiFramePerspectiveDiagnostics['anchors'];
      trackedAnchorsRef.current = absoluteAnchors;
      setAcquisition({
        stage: 'ready',
        anchors: absoluteAnchors,
        confidence: result.diagnostics.confidence,
        moduleScale: absoluteAnchors.reduce((sum, anchor) => sum + anchor.scale, 0) / absoluteAnchors.length,
        angle: absoluteAnchors.reduce((sum, anchor) => sum + anchor.angle, 0) / absoluteAnchors.length,
        geometryRatio: 0,
        sampleWidth: image.width,
        sampleHeight: image.height,
        elapsedMs: result.diagnostics.decodeMs,
      });
    } else {
      framesSinceFullScanRef.current += 1;
      acquisitionFailureRef.current += 1;
    }

    if (dropped && !result) {
      setCameraStats(prev => ({ ...prev, attempts: prev.attempts + 1, dropped: prev.dropped + 1 }));
      return;
    }

    const elapsed = performance.now() - captureStarted;

    setCameraStats(prev => {
      const nextHits = prev.hits + (result ? 1 : 0);
      const elapsedFromStart = prev.startedAt ? Math.max(0.001, (performance.now() - prev.startedAt) / 1000) : 0;
      return {
        ...prev,
        attempts: prev.attempts + 1,
        hits: nextHits,
        workerHits: prev.workerHits + (workerResult ? 1 : 0),
        localHits: prev.localHits + (!workerResult && result ? 1 : 0),
        lastMs: elapsed,
        dropped: prev.dropped + (dropped ? 1 : 0),
        captureFps: elapsedFromStart ? (prev.attempts + 1) / elapsedFromStart : 0,
        decodeFps: elapsedFromStart ? nextHits / elapsedFromStart : 0,
        lastConfidence: result ? result.diagnostics.confidence : prev.lastConfidence,
      };
    });

    if (!result) {
      if (decodePoolRef.current.capacity === 0) {
        setStatus('OptiFrame decoder workers are unavailable in this browser. Upload decoding still works; camera MVP requires Web Worker support.');
      } else if (acquisitionFailureRef.current >= 2) {
        setStatus('Searching for a 1× OptiFrame…');
        acquisitionFailureRef.current = 0;
      }
      return;
    }

    const frame = result.frame;
    if (frame.sequence === 0 && receiver.complete) {
      seenSequenceRef.current.clear();
      assemblerRef.current.reset();
    }

    const duplicate = seenSequenceRef.current.has(frame.sequence);
    const assembly = assemblerRef.current.add(frame);
    seenSequenceRef.current.add(frame.sequence);

    setCameraStats(prev => {
      const elapsedFromStart = prev.startedAt ? Math.max(0.001, (performance.now() - prev.startedAt) / 1000) : 0;
      return {
        ...prev,
        duplicates: prev.duplicates + (duplicate ? 1 : 0),
        bytes: assembly.bytes,
        goodputBps: elapsedFromStart ? assembly.bytes / elapsedFromStart : 0,
      };
    });

    setReceiver({
      total: assembly.total,
      received: assembly.received,
      bytes: assembly.bytes,
      missing: assembly.missing.slice(0, 40),
      complete: assembly.complete,
    });

    setStatus(`Live frame ${frame.sequence + 1}/${frame.total} · ${Math.round(result.diagnostics.confidence * 100)}% anchor confidence · ${result.diagnostics.decodeMs.toFixed(0)} ms decode${workerResult ? ` · worker ${workerResult.workerIndex + 1}` : ' · local'} · ${decodePoolRef.current.busyCount}/${decodePoolRef.current.capacity} workers busy`);

    if (assembly.complete && assembly.payload) {
      finishReceivedPayload(assembly.payload);
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser does not expose camera access.');
      return;
    }

    stopCamera();
    setCameraError('');
    assemblerRef.current.reset();
    seenSequenceRef.current.clear();
    trackedAnchorsRef.current = null;
    framesSinceFullScanRef.current = 0;
    setReceiver({ total: 0, received: 0, bytes: 0, missing: [], complete: false });
    setCameraDecoded('');
    setAcquisition({ stage: 'searching', anchors: [], confidence: 0, moduleScale: 0, angle: 0, geometryRatio: 0, sampleWidth: 0, sampleHeight: 0, elapsedMs: 0 });
    acquisitionFailureRef.current = 0;
    acquisitionTestRef.current = false;
    acquisitionTestMetricsRef.current = emptyAcquisitionTest();
    setAcquisitionTest(emptyAcquisitionTest());
    setCameraStats({ attempts: 0, hits: 0, duplicates: 0, dropped: 0, workerHits: 0, localHits: 0, lastMs: 0, bytes: 0, captureFps: 0, decodeFps: 0, goodputBps: 0, lastConfidence: 0, cameraWidth: 0, cameraHeight: 0, cameraFrameRate: 0, startedAt: performance.now() });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      const capabilities = track?.getCapabilities?.() as OptiVideoCapabilities | undefined;
      setCameraCapabilities(capabilities ? Object.keys(capabilities).filter(key => ['width','height','frameRate','focusMode','zoom','torch','resizeMode'].includes(key)) : []);

      if (track && capabilities) {
        const focusModes = capabilities.focusMode;
        const resizeModes = capabilities.resizeMode;
        try {
          const cameraConstraints: OptiVideoTrackConstraints = {
            width: { ideal: Math.min(1920, capabilities.width?.max ?? 1920) },
            height: { ideal: Math.min(1080, capabilities.height?.max ?? 1080) },
            frameRate: { ideal: Math.min(30, capabilities.frameRate?.max ?? 30) },
          };
          if (Array.isArray(resizeModes) && resizeModes.includes('none')) {
            cameraConstraints.resizeMode = 'none';
          }
          if (Array.isArray(focusModes) && focusModes.includes('continuous')) {
            cameraConstraints.advanced = [{ focusMode: 'continuous' }];
          }
          await track.applyConstraints(cameraConstraints as MediaTrackConstraints);
        } catch {
          // Keep the stream if the browser rejects an optional camera optimization.
        }
      }
      const finalSettings = track?.getSettings();
      setCameraStats(prev => ({
        ...prev,
        cameraWidth: finalSettings?.width ?? settings?.width ?? 0,
        cameraHeight: finalSettings?.height ?? settings?.height ?? 0,
        cameraFrameRate: finalSettings?.frameRate ?? settings?.frameRate ?? 0,
      }));
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);

      const tick = async () => {
        if (!streamRef.current) return;
        const started = performance.now();
        await decodeCameraFrame();
        const processingMs = performance.now() - started;
        // Keep capture responsive without forcing a fixed cadence onto slower
        // devices. The sender cadence is independently configurable.
        const nextDelay = Math.max(140, Math.min(500, Math.round(processingMs * 1.35)));
        loopRef.current = window.setTimeout(() => void tick(), nextDelay);
      };
      loopRef.current = window.setTimeout(() => void tick(), 140);
    } catch (error) {
      setCameraError(error instanceof DOMException ? error.message : 'Camera permission was denied or unavailable.');
      stopCamera();
    }
  }

  function startAcquisitionTest() {
    if (!cameraOn) {
      setStatus('Start the camera before running the Camera test.');
      return;
    }
    setLaneCount(1);
    setStreamPlaying(false);
    acquisitionTestRef.current = true;
    const next = emptyAcquisitionTest();
    acquisitionTestMetricsRef.current = next;
    setAcquisitionTest({ ...next, running: true });
    setAcquisition({
      stage: 'searching',
      anchors: [],
      confidence: 0,
      moduleScale: 0,
      angle: 0,
      geometryRatio: 0,
      sampleWidth: 0,
      sampleHeight: 0,
      elapsedMs: 0,
    });
    setStatus('Camera test armed · sender paused · hold one frame steady inside the camera view.');
  }

  function stopAcquisitionTest() {
    acquisitionTestRef.current = false;
    setAcquisitionTest(previous => ({ ...previous, running: false }));
    setStatus('Camera test stopped.');
  }

  function resetReceiver() {
    assemblerRef.current.reset();
    seenSequenceRef.current.clear();
    trackedAnchorsRef.current = null;
    framesSinceFullScanRef.current = 0;
    setReceiver({ total: 0, received: 0, bytes: 0, missing: [], complete: false });
    setCameraDecoded('');
    setReceivedFile(null);
    if (receivedFileUrlRef.current) URL.revokeObjectURL(receivedFileUrlRef.current);
    receivedFileUrlRef.current = '';
    setReceivedFileUrl('');
    setCameraStats(prev => ({ ...prev, hits: 0, duplicates: 0, dropped: 0, workerHits: 0, localHits: 0, bytes: 0, captureFps: 0, decodeFps: 0, goodputBps: 0, lastConfidence: 0 }));
  }

  return (
    <section className="optiframe-page mx-auto max-w-7xl py-8 sm:py-12">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[.18em] text-cyan-300">Experimental file sharing</p>
          <h1 className="mt-2 text-4xl font-black text-[var(--text)] sm:text-6xl">Share files using your screen.</h1>
          <p className="mt-4 max-w-4xl text-sm leading-7 text-[var(--text-muted)]">Choose a file, show it on this screen, and use another device to receive it. Advanced test controls are below.</p>
        </div>
        <div className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-xs font-bold text-cyan-300">{capacity} data per screen</div>
      </div>

      <GlassCard>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-400/10 text-cyan-300"><Zap size={18}/></span>
              <div>
                <p className="text-lg font-black text-[var(--text)]">Share a file</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Device A sends · Device B scans with its camera · the original file is reconstructed automatically.</p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-black text-slate-950">
              <Upload size={15}/> {transferFile ? 'Choose another file' : 'Choose file'}
              <input type="file" className="hidden" onChange={event => { void selectTransferFile(event.target.files?.[0]); event.currentTarget.value = ''; }}/>
            </label>
            {transferFile && <button onClick={clearTransferFile} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--text)]">Clear</button>}
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-4"><p className="text-[10px] font-black uppercase tracking-[.14em] text-[var(--text-muted)]">Mode</p><p className="mt-1 text-sm font-black text-[var(--text)]">{transferFile ? 'FILE' : 'TEXT'}</p></div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-4"><p className="text-[10px] font-black uppercase tracking-[.14em] text-[var(--text-muted)]">Payload</p><p className="mt-1 text-sm font-black text-[var(--text)]">{(transferData?.length ?? new TextEncoder().encode(text).length).toLocaleString()} bytes</p></div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-4"><p className="text-[10px] font-black uppercase tracking-[.14em] text-[var(--text-muted)]">Frames</p><p className="mt-1 text-sm font-black text-[var(--text)]">{streamPayload.length}</p></div>
        </div>
        {transferFile && <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4"><p className="text-xs font-black text-cyan-200">{transferFile.name}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{transferFile.type || 'application/octet-stream'} · {transferFile.size.toLocaleString()} bytes · ready to display on the sending device.</p></div>}
      </GlassCard>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <GlassCard>
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-400/10 text-violet-300"><FlaskConical size={18}/></span>
            <div><p className="text-sm font-bold text-[var(--text)]">Frame builder</p><p className="mt-1 text-[10px] uppercase tracking-[.14em] text-[var(--text-muted)]">Axis-aligned + perspective-corrected image decode</p></div>
          </div>
          <textarea value={text} onChange={event => setText(event.target.value)} className="mt-5 min-h-32 w-full rounded-[22px] border border-[var(--border)] bg-[var(--bg-soft)] p-4 text-sm text-[var(--text)] outline-none" />
          <div className="mt-2 text-[10px] text-[var(--text-muted)]">{new TextEncoder().encode(text).length.toLocaleString()} bytes · stream automatically fragments above {capacity.toLocaleString()} bytes.</div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><span className="text-[10px] text-[var(--text-muted)]">Sequence</span><input type="number" min="0" max="65535" value={seq} onChange={event => setSeq(Math.max(0, Math.min(65535, Number(event.target.value) || 0)))} className="mt-1 w-full bg-transparent text-[var(--text)] outline-none" /></label>
            <label className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><span className="text-[10px] text-[var(--text-muted)]">Total</span><input type="number" min="1" max="65535" value={total} onChange={event => setTotal(Math.max(1, Math.min(65535, Number(event.target.value) || 1)))} className="mt-1 w-full bg-transparent text-[var(--text)] outline-none" /></label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <GlassButton onClick={generate}><Zap size={14}/> Generate OptiFrame</GlassButton>
            <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-sm font-bold text-[var(--text)]"><Upload size={14}/> Decode image<input type="file" accept="image/*" className="hidden" onChange={event => { void load(event.target.files?.[0]); event.currentTarget.value = ''; }}/></label>
            <button onClick={save} disabled={!image} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--text)] disabled:opacity-40"><Download size={14}/> Save image</button>
          </div>
          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-4"><p className="text-xs font-bold text-[var(--text)]">Status</p><p className="mt-1 text-xs leading-6 text-[var(--text-muted)]">{status}</p></div>
          {decoded && <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4"><p className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-300">Received</p><p className="mt-2 break-words text-sm text-[var(--text)]">{decoded}</p><button onClick={() => void copy()} className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--text)]"><Copy size={13}/> Copy</button></div>}
        </GlassCard>

        <GlassCard>
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-sm font-bold text-[var(--text)]">Sharing screen</p><p className="mt-1 text-[10px] uppercase tracking-[.14em] text-[var(--text-muted)]">{OPTIFRAME_SIZE}×{OPTIFRAME_SIZE} protocol · 1× renders 768 px · 2×/4× render 384 px lanes</p></div>
            <span className="rounded-full border border-[var(--border)] px-3 py-2 text-[10px] font-bold text-[var(--text-muted)]">{streamPayload.length} stream frame{streamPayload.length === 1 ? '' : 's'}</span>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><div><p className="text-[10px] font-black uppercase tracking-[.14em] text-[var(--text-muted)]">Multiple codes</p><p className="mt-1 text-xs text-[var(--text-muted)]">The screen can show more than one code at a time.</p></div><div className="flex rounded-full border border-[var(--border)] p-1">{([1, 2, 4] as OptiLaneCount[]).map(count => <button key={count} onClick={() => setLaneCount(count)} className={laneCount === count ? 'rounded-full bg-white px-3 py-1.5 text-[10px] font-black text-slate-950' : 'rounded-full px-3 py-1.5 text-[10px] font-black text-[var(--text-muted)]'}>{count}×</button>)}</div></div>
          <div className="mt-5 grid place-items-center rounded-[26px] bg-white p-4">
            {streamSurface ? (
              <canvas
                ref={streamCanvasRef}
                aria-label="OptiFrame optical stream surface"
                className={`optiframe-surface block h-auto w-full max-w-[760px] ${laneCount === 2 ? 'aspect-[2/1]' : 'aspect-square'}`}
              />
            ) : <div className={laneCount === 2 ? 'aspect-[2/1] w-full max-w-[760px]' : 'aspect-square w-full max-w-[760px]'} />}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <GlassButton onClick={() => setStreamPlaying(value => !value)}>{streamPlaying ? <Pause size={14}/> : <Play size={14}/>} {streamPlaying ? 'Pause' : 'Start sharing'}</GlassButton>
            {laneCount === 1 && <button onClick={() => setOpticalDisplayMode(true)} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--text)]"><Maximize2 size={14}/> Full screen</button>}
            <label className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--text)]">
              Speed
              <select value={streamIntervalMs} onChange={event => setStreamIntervalMs(Number(event.target.value))} className="bg-transparent outline-none">
                <option value={16}>16 ms</option>
                <option value={24}>24 ms</option>
                <option value={32}>32 ms</option>
                <option value={60}>60 ms</option>
                <option value={80}>80 ms</option>
                <option value={120}>120 ms</option>
                <option value={180}>180 ms</option>
                <option value={300}>300 ms</option>
                <option value={500}>500 ms</option>
              </select>
            </label>
            <button onClick={() => setStreamIndex(index => (index + streamPayload.length - laneCount) % Math.max(1, streamPayload.length))} className="rounded-full border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--text)]">Previous</button>
            <button onClick={() => setStreamIndex(index => (index + laneCount) % Math.max(1, streamPayload.length))} className="rounded-full border border-[var(--border)] px-4 py-2 text-xs font-bold text-[var(--text)]">Next</button>
          </div>
          <p className="mt-3 text-xs text-[var(--text-muted)]">{laneCount > 1 ? `Multi-lane mode displays ${laneCount} independent frames at once; the receiver uses the matching ${laneCount === 2 ? '2:1' : '1:1'} grid aspect ratio and decodes lanes through the worker pool.` : 'On the sending device, choose a file above, then press Start sharing or Full screen. On the receiving device, open the same page, press Start camera, and point it at this optical surface. Keep the whole code inside the guide.'}</p>
        </GlassCard>
      </div>

      {opticalDisplayMode && streamSurface && (
        <div className="fixed inset-0 z-[100] flex min-h-0 flex-col bg-white p-2 sm:p-4">
          <div className="flex items-center justify-between gap-3 text-slate-900">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.18em] text-cyan-700">OptiFrame 1× optical display</p>
              <p className="text-xs font-bold">Fill this screen with the frame. Keep all four finder anchors visible to the receiver.</p>
            </div>
            <button onClick={() => setOpticalDisplayMode(false)} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-black text-slate-900 shadow-sm"><Minimize2 size={14}/> Exit</button>
          </div>
          <div className="min-h-0 flex-1 grid place-items-center py-2">
            <canvas
              ref={presentationCanvasRef}
              aria-label="Fullscreen OptiFrame 1x optical display"
              className="block h-auto max-h-full w-auto max-w-full"
            />
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <GlassCard>
          <div className="flex items-center justify-between gap-3">
            <div><div className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">{cameraOn ? <CheckCircle2 size={16} className="text-emerald-300"/> : <ScanLine size={16} className="text-cyan-300"/>} Receive on camera</div><p className="mt-1 text-xs text-[var(--text-muted)]">The camera reads the shared screen directly on this device. Camera images stay on this device.</p></div>
            <div className={`rounded-full border px-3 py-2 text-[10px] font-black tracking-[.12em] ${cameraStats.hits ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-300' : cameraOn ? 'border-amber-300/20 bg-amber-300/10 text-amber-200' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
              {acquisition.stage === 'ready' ? 'READY' : cameraOn ? 'LOOKING' : 'OFF'}
            </div>
            <button onClick={() => void (cameraOn ? stopCamera() : startCamera())} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-bold text-slate-950">{cameraOn ? <CameraOff size={14}/> : <Camera size={14}/>} {cameraOn ? 'Stop camera' : 'Start camera'}</button>
          </div>
          <div className="optiframe-camera mt-4 overflow-hidden rounded-[26px] bg-black">
            <div className="relative min-h-[460px] aspect-video sm:min-h-[560px] lg:min-h-[620px]">
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
              {!cameraOn && <div className="absolute inset-0 grid place-items-center bg-black/55"><div className="text-center"><ScanLine size={28} className="mx-auto text-white/70"/><p className="mt-3 text-sm font-bold text-white">Point the camera at the sharing screen</p><p className="mt-1 text-xs text-white/50">Keep the whole code inside the guide.</p></div></div>}
              {cameraOn && acquisition.anchors.length > 0 && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={"0 0 " + Math.max(1, acquisition.sampleWidth) + " " + Math.max(1, acquisition.sampleHeight)} preserveAspectRatio="none">
                  {acquisition.anchors.length >= 2 && <polyline points={acquisition.anchors.map(anchor => anchor.x + "," + anchor.y).join(" ")} fill="none" stroke="rgba(34,211,238,.9)" strokeWidth={Math.max(2, acquisition.moduleScale * 0.7)} />}
                  {acquisition.anchors.map((anchor, index) => <g key={index}><circle cx={anchor.x} cy={anchor.y} r={Math.max(6, acquisition.moduleScale * 1.6)} fill="rgba(34,211,238,.16)" stroke="white" strokeWidth="2"/><text x={anchor.x + 10} y={anchor.y - 10} fill="white" fontSize={Math.max(12, acquisition.moduleScale * 1.4)} fontWeight="800">{['TL','TR','BL','BR'][index]} {Math.round(anchor.score * 100)}%</text></g>)}
                </svg>
              )}
              {cameraOn && <div className="pointer-events-none absolute inset-[5%] rounded-[28px] border-2 border-cyan-300/70 shadow-[0_0_0_999px_rgba(0,0,0,.16),0_0_32px_rgba(34,211,238,.2)]"><div className="absolute inset-4 border border-white/15"/></div>}
            </div>
          </div>
          {cameraError && <div className="mt-3 rounded-2xl border border-rose-300/20 bg-rose-400/10 p-4 text-xs leading-6 text-rose-100">{cameraError}</div>}
          {cameraOn && cameraStats.cameraWidth > 0 && cameraStats.cameraWidth < 960 && <div className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-xs leading-6 text-amber-100">The browser supplied a {cameraStats.cameraWidth}×{cameraStats.cameraHeight} camera stream. The detector prefers a higher-resolution feed because more camera pixels per optical module generally gives it more information; this browser did not provide the preferred target.</div>}
          <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4">
            <div className="flex items-center justify-between gap-3"><p className="text-xs font-black uppercase tracking-[.14em] text-cyan-200">Camera details</p><span className="rounded-full border border-cyan-300/20 px-2 py-1 text-[10px] font-black text-cyan-200">{acquisition.stage.toUpperCase()}</span></div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><p className="text-[10px] text-[var(--text-muted)]">Corners found</p><p className="text-sm font-black text-[var(--text)]">{acquisition.anchors.length}/4</p></div>
              <div><p className="text-[10px] text-[var(--text-muted)]">Reading confidence</p><p className="text-sm font-black text-[var(--text)]">{Math.round(acquisition.confidence * 100)}%</p></div>
              <div><p className="text-[10px] text-[var(--text-muted)]">Code size</p><p className="text-sm font-black text-[var(--text)]">{acquisition.moduleScale ? acquisition.moduleScale.toFixed(1) : '—'} px</p></div>
              <div><p className="text-[10px] text-[var(--text-muted)]">Angle</p><p className="text-sm font-black text-[var(--text)]">{acquisition.angle.toFixed(1)}°</p></div>
            </div>
            <p className="mt-3 text-[10px] leading-5 text-[var(--text-muted)]">Sample {acquisition.sampleWidth || '—'}×{acquisition.sampleHeight || '—'} · acquisition {acquisition.elapsedMs.toFixed(0)} ms · camera {cameraStats.cameraFrameRate ? cameraStats.cameraFrameRate.toFixed(1) + ' FPS' : 'FPS unavailable'} · capabilities: {cameraCapabilities.length ? cameraCapabilities.join(', ') : 'not exposed'}</p>

          <div className="mt-4 rounded-2xl border border-violet-300/20 bg-violet-300/10 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[.14em] text-violet-200"><Activity size={14}/> Camera test</p>
                <p className="mt-1 text-[10px] leading-5 text-[var(--text-muted)]">Runs a short camera test to see how well this device can read the sharing screen.</p>
              </div>
              <button
                onClick={acquisitionTest.running ? stopAcquisitionTest : startAcquisitionTest}
                disabled={!cameraOn}
                className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {acquisitionTest.running ? <Timer size={14}/> : <Crosshair size={14}/>}
                {acquisitionTest.running ? 'Stop test' : 'Run camera test'}
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><p className="text-[10px] text-[var(--text-muted)]">Samples</p><p className="text-sm font-black text-[var(--text)]">{acquisitionTest.samples}/{ACQUISITION_TEST_SAMPLES}</p></div>
              <div><p className="text-[10px] text-[var(--text-muted)]">Good reads</p><p className="text-sm font-black text-[var(--text)]">{acquisitionTest.samples ? Math.round(acquisitionTest.locks / acquisitionTest.samples * 100) + '%' : '—'}</p></div>
              <div><p className="text-[10px] text-[var(--text-muted)]">Average corners</p><p className="text-sm font-black text-[var(--text)]">{acquisitionTest.samples ? (acquisitionTest.totalCorners / acquisitionTest.samples).toFixed(1) : '—'}</p></div>
              <div><p className="text-[10px] text-[var(--text-muted)]">Average / fastest</p><p className="text-sm font-black text-[var(--text)]">{acquisitionTest.samples ? acquisitionTest.averageMs.toFixed(0) + ' / ' + acquisitionTest.peakMs.toFixed(0) + ' ms' : '—'}</p></div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold text-[var(--text-muted)]">
              {(['searching', 'anchors', 'geometry', 'calibration', 'ready'] as const).map(stage => (
                <span key={stage} className="rounded-full border border-[var(--border)] px-2 py-1">{stage}: {acquisitionTest.stageCounts[stage]}</span>
              ))}
            </div>

            <p className="mt-3 text-[10px] leading-5 text-[var(--text-muted)]">Last stage: {acquisitionTest.lastStage.toUpperCase()} · The test forces 1× mode and pauses the sender so every sample sees the same optical frame.</p>
          </div>
          </div>
          <div className="optiframe-metrics mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Attempts</p><p className="mt-1 text-lg font-black text-[var(--text)]">{cameraStats.attempts}</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Decoded</p><p className="mt-1 text-lg font-black text-[var(--text)]">{cameraStats.hits}</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Dropped</p><p className="mt-1 text-lg font-black text-[var(--text)]">{cameraStats.dropped}</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Duplicates</p><p className="mt-1 text-lg font-black text-[var(--text)]">{cameraStats.duplicates}</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Decode ms</p><p className="mt-1 text-lg font-black text-[var(--text)]">{cameraStats.lastMs.toFixed(0)}</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Goodput</p><p className="mt-1 text-lg font-black text-[var(--text)]">{(cameraStats.goodputBps / 1024).toFixed(1)} KB/s</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Workers</p><p className="mt-1 text-lg font-black text-[var(--text)]">{decodePoolRef.current.busyCount}/{decodePoolRef.current.capacity}</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Decode FPS</p><p className="mt-1 text-lg font-black text-[var(--text)]">{cameraStats.decodeFps.toFixed(1)}</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Anchor confidence</p><p className="mt-1 text-lg font-black text-[var(--text)]">{Math.round(cameraStats.lastConfidence * 100)}%</p></div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3"><p className="text-[10px] text-[var(--text-muted)]">Camera</p><p className="mt-1 text-sm font-black text-[var(--text)]">{cameraStats.cameraWidth && cameraStats.cameraHeight ? `${cameraStats.cameraWidth}×${cameraStats.cameraHeight}` : '—'}</p></div>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-bold text-[var(--text)]">Receiver state</p><p className="mt-1 text-xs text-[var(--text-muted)]">{receiver.total ? `${receiver.received}/${receiver.total} frames received` : 'Waiting for a frame.'}</p></div><button onClick={resetReceiver} className="rounded-full p-2 text-[var(--text-muted)] hover:bg-white/10" aria-label="Reset receiver"><RotateCcw size={16}/></button></div>
          {receiver.total > 0 && <><div className="mt-5 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all" style={{width:`${Math.min(100, receiver.received / receiver.total * 100)}%`}}/></div><p className="mt-3 text-xs text-[var(--text-muted)]">{receiver.complete ? 'Complete payload reassembled in sequence order.' : `Missing: ${receiver.missing.slice(0, 18).join(', ')}${receiver.missing.length > 18 ? '…' : ''}`}</p></>}
          {receivedFile && receivedFileUrl ? <div className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-300/10 p-4"><p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.14em] text-emerald-300"><CheckCircle2 size={14}/> File received</p><p className="mt-2 text-sm font-black text-[var(--text)]">{receivedFile.name}</p><p className="mt-1 text-xs text-[var(--text-muted)]">{receivedFile.type} · {receivedFile.size.toLocaleString()} bytes</p><a href={receivedFileUrl} download={receivedFile.name} className="mt-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-black text-slate-950"><Download size={13}/> Save image received file</a></div> : cameraDecoded && <div className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-300/10 p-4"><p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.14em] text-emerald-300"><CheckCircle2 size={14}/> Reassembled text</p><p className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-[var(--text)]">{cameraDecoded}</p><button onClick={() => void navigator.clipboard?.writeText(cameraDecoded)} className="mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--text)]"><Copy size={13}/> Copy text</button></div>}
          <div className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4"><p className="text-xs font-bold text-[var(--text)]">Lab status</p><p className="mt-1 text-xs leading-6 text-[var(--text-muted)]">The real file-transfer path is now wired to the optical stream: files are wrapped with filename/type metadata, fragmented into OptiFrames, displayed continuously, camera-decoded, reassembled, and offered as the original downloadable file. Keep 1× mode for the first physical test. Advanced recovery and speed work comes after this MVP passes a real device-to-device transfer.</p></div>
        </GlassCard>
      </div>
    </section>
  );
}
