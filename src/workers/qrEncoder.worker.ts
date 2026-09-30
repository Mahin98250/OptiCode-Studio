import QRCode from 'qrcode';

type EncodeRequest = {
  id: number;
  value: string;
};

type EncodeResult = {
  id: number;
  size: number;
  data: ArrayBuffer;
  processingMs: number;
};

type ModuleMatrix = { size: number; data: Uint8Array | boolean[] };

function encode(value: string) {
  const started = performance.now();
  const code = QRCode.create(value, { errorCorrectionLevel: 'L' }) as unknown as { modules: ModuleMatrix };
  const raw = code.modules.data;
  const data = raw instanceof Uint8Array
    ? raw.slice()
    : new Uint8Array(Array.from(raw, entry => (entry ? 1 : 0)));

  return {
    size: code.modules.size,
    data,
    processingMs: performance.now() - started,
  };
}

type WorkerScope = {
  onmessage: (event: MessageEvent<EncodeRequest>) => void;
  postMessage: (message: EncodeResult, transfer?: Transferable[]) => void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  try {
    const encoded = encode(event.data.value);
    scope.postMessage(
      {
        id: event.data.id,
        size: encoded.size,
        data: encoded.data.buffer,
        processingMs: encoded.processingMs,
      },
      [encoded.data.buffer],
    );
  } catch {
    scope.postMessage({
      id: event.data.id,
      size: 0,
      data: new ArrayBuffer(0),
      processingMs: 0,
    });
  }
};
