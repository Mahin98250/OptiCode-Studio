import jsQR from 'jsqr';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const localWasmUrl = new URL(
  `${import.meta.env.BASE_URL}zxing_reader.wasm`,
  self.location.origin,
).toString();

const zxingWarmup=prepareZXingModule({
  overrides:{
    locateFile:(path,prefix)=>path.endsWith('.wasm') ? localWasmUrl : prefix+path,
  },
  fireImmediately:true,
}).then(()=>true).catch(()=>false);

type DecodeRequest = {
  id:number;
  width:number;
  height:number;
  buffer:ArrayBuffer;
  maxDepth?:number;
};

type DecodeBox = { x:number; y:number; width:number; height:number };

type DecodeResult = {
  id:number;
  values:string[];
  boxes:DecodeBox[];
  regionsScanned:number;
  processingMs:number;
  decoder:'wasm'|'jsqr';
};

const keyFor=(value:string)=>value.length>180?value.slice(0,180):value;

function boxFromPosition(position:unknown):DecodeBox|undefined{
  const p=position as {
    topLeft?:{x:number;y:number};
    topRight?:{x:number;y:number};
    bottomLeft?:{x:number;y:number};
    bottomRight?:{x:number;y:number};
  }|undefined;
  if(!p) return;
  const points=([p.topLeft,p.topRight,p.bottomLeft,p.bottomRight].filter(Boolean) as Array<{x:number;y:number}>).filter(point=>
    Number.isFinite(point.x) && Number.isFinite(point.y)
  );
  if(points.length<2)return;
  const xs=points.map(point=>point.x);
  const ys=points.map(point=>point.y);
  return {
    x:Math.max(0,Math.min(...xs)),
    y:Math.max(0,Math.min(...ys)),
    width:Math.max(1,Math.max(...xs)-Math.min(...xs)),
    height:Math.max(1,Math.max(...ys)-Math.min(...ys)),
  };
}

async function decodeWasm(data:Uint8ClampedArray,width:number,height:number){
  const results=await readBarcodes(
    {data:new Uint8ClampedArray(data),width,height} as unknown as ImageData,
    {
      formats:['QRCode'],
      maxNumberOfSymbols:4,
      tryHarder:false,
      tryRotate:false,
      tryInvert:false,
      tryDownscale:false,
      tryDenoise:false,
      returnErrors:false,
      textMode:'Plain',
    },
  );

  const values:string[]=[];
  const boxes:DecodeBox[]=[];
  const seen=new Set<string>();
  for(const result of results){
    if(!result || !result.isValid || typeof result.text!=='string' || !result.text)continue;
    const key=keyFor(result.text);
    if(seen.has(key))continue;
    seen.add(key);
    values.push(result.text);
    const box=boxFromPosition(result.position);
    if(box)boxes.push(box);
  }
  return {values,boxes};
}

async function decode(request:DecodeRequest):Promise<DecodeResult>{
  const started=performance.now();
  const data=new Uint8ClampedArray(request.buffer);
  // Keep the WASM instantiation off the first optical frame. The module is
  // prepared once per worker and then reused for subsequent reads.
  await zxingWarmup;
  const maxDepth=Math.max(0,Math.min(1,request.maxDepth??1));

  try{
    const wasm=await decodeWasm(data,request.width,request.height);
    if(wasm.values.length>0){
      return {
        id:request.id,
        values:wasm.values,
        boxes:wasm.boxes,
        regionsScanned:1,
        processingMs:performance.now()-started,
        decoder:'wasm',
      };
    }
  }catch{
    // Fall through to jsQR. A worker-level WASM failure must never kill the receiver.
  }

  const values:string[]=[];
  const boxes:DecodeBox[]=[];
  const localSeen=new Set<string>();
  let regionsScanned=0;
  let scratch=new Uint8ClampedArray(0);

  const add=(value?:string, location?:{topLeftCorner?:{x:number;y:number};topRightCorner?:{x:number;y:number};bottomLeftCorner?:{x:number;y:number};bottomRightCorner?:{x:number;y:number}})=>{
    if(!value)return;
    const key=keyFor(value);
    if(localSeen.has(key))return;
    localSeen.add(key);
    values.push(value);
    if(location){
      const points=[location.topLeftCorner,location.topRightCorner,location.bottomLeftCorner,location.bottomRightCorner]
        .filter((point):point is {x:number;y:number}=>Boolean(point));
      if(points.length>=2){
        const xs=points.map(point=>point.x);
        const ys=points.map(point=>point.y);
        boxes.push({
          x:Math.max(0,Math.min(...xs)),
          y:Math.max(0,Math.min(...ys)),
          width:Math.max(1,Math.max(...xs)-Math.min(...xs)),
          height:Math.max(1,Math.max(...ys)-Math.min(...ys)),
        });
      }
    }
  };

  const inspect=(x:number,y:number,width:number,height:number)=>{
    const clippedWidth=Math.max(1,Math.min(width,request.width-x));
    const clippedHeight=Math.max(1,Math.min(height,request.height-y));
    regionsScanned+=1;

    try{
      if(x===0 && y===0 && clippedWidth===request.width && clippedHeight===request.height){
        const decoded=jsQR(data,request.width,request.height,{inversionAttempts:'dontInvert'});
        add(decoded?.data,decoded?.location);
        return;
      }

      const required=clippedWidth*clippedHeight*4;
      if(scratch.length<required)scratch=new Uint8ClampedArray(required);
      for(let row=0;row<clippedHeight;row+=1){
        const from=((y+row)*request.width+x)*4;
        scratch.set(data.subarray(from,from+clippedWidth*4),row*clippedWidth*4);
      }

      const crop=scratch.subarray(0,required);
      const fast=jsQR(crop,clippedWidth,clippedHeight,{inversionAttempts:'dontInvert'});
      if(fast){
        add(fast.data,{
          topLeftCorner:{x:fast.location.topLeftCorner.x+x,y:fast.location.topLeftCorner.y+y},
          topRightCorner:{x:fast.location.topRightCorner.x+x,y:fast.location.topRightCorner.y+y},
          bottomLeftCorner:{x:fast.location.bottomLeftCorner.x+x,y:fast.location.bottomLeftCorner.y+y},
          bottomRightCorner:{x:fast.location.bottomRightCorner.x+x,y:fast.location.bottomRightCorner.y+y},
        });
      }else if(maxDepth>=1){
        const recovered=jsQR(crop,clippedWidth,clippedHeight,{inversionAttempts:'attemptBoth'});
        if(recovered){
          add(recovered.data,{
            topLeftCorner:{x:recovered.location.topLeftCorner.x+x,y:recovered.location.topLeftCorner.y+y},
            topRightCorner:{x:recovered.location.topRightCorner.x+x,y:recovered.location.topRightCorner.y+y},
            bottomLeftCorner:{x:recovered.location.bottomLeftCorner.x+x,y:recovered.location.bottomLeftCorner.y+y},
            bottomRightCorner:{x:recovered.location.bottomRightCorner.x+x,y:recovered.location.bottomRightCorner.y+y},
          });
        }
      }
    }catch{}
  };

  inspect(0,0,request.width,request.height);
  if(maxDepth>=1 && values.length<4){
    const grid=2;
    const stepX=request.width/grid;
    const stepY=request.height/grid;
    const overlapX=Math.floor(stepX*.16);
    const overlapY=Math.floor(stepY*.16);
    for(let row=0;row<grid;row+=1){
      for(let col=0;col<grid;col+=1){
        const x=Math.max(0,Math.floor(col*stepX-overlapX));
        const y=Math.max(0,Math.floor(row*stepY-overlapY));
        const right=Math.min(request.width,Math.ceil((col+1)*stepX+overlapX));
        const bottom=Math.min(request.height,Math.ceil((row+1)*stepY+overlapY));
        inspect(x,y,right-x,bottom-y);
      }
    }
  }

  return {
    id:request.id,
    values,
    boxes,
    regionsScanned,
    processingMs:performance.now()-started,
    decoder:'jsqr',
  };
}

type WorkerScope={
  onmessage:(event:MessageEvent<DecodeRequest>)=>void;
  postMessage:(message:DecodeResult)=>void;
};

const scope=self as unknown as WorkerScope;
scope.onmessage=(event)=>{
  void decode(event.data)
    .then(result=>scope.postMessage(result))
    .catch(()=>scope.postMessage({
      id:event.data.id,
      values:[],
      boxes:[],
      regionsScanned:0,
      processingMs:0,
      decoder:'jsqr',
    }));
};
