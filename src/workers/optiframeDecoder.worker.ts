import { decodeOptiFramePerspective, type OptiFramePerspectiveDiagnostics } from '../lib/optiframe';

type Request = {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  previousAnchors?: OptiFramePerspectiveDiagnostics['anchors'] | null;
};

type Response = {
  id: number;
  ok: boolean;
  frame?: {
    version: number;
    sequence: number;
    total: number;
    payload: Uint8Array;
  };
  diagnostics?: OptiFramePerspectiveDiagnostics;
  error?: string;
};

const scope = self as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (message: Response, transfer?: Transferable[]) => void;
};

scope.onmessage = (event) => {
  const { id, width, height, buffer, previousAnchors = null } = event.data;
  try {
    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const result = decodeOptiFramePerspective(image, previousAnchors);
    if (!result) {
      scope.postMessage({ id, ok: false });
      return;
    }

    const payloadBuffer = result.frame.payload.slice().buffer;
    scope.postMessage({
      id,
      ok: true,
      frame: {
        version: result.frame.version,
        sequence: result.frame.sequence,
        total: result.frame.total,
        payload: new Uint8Array(payloadBuffer),
      },
      diagnostics: result.diagnostics,
    }, [payloadBuffer]);
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'OptiFrame worker decode failed.',
    });
  }
};
