import jsQR from 'jsqr';

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
};

const keyFor=(value:string)=>value.length>180?value.slice(0,180):value;

function decode(request:DecodeRequest):DecodeResult{
  const started=performance.now();
  const values:string[]=[];
  const boxes:DecodeBox[]=[];
  const localSeen=new Set<string>();
  let regionsScanned=0;
  const data=new Uint8ClampedArray(request.buffer);

  // The realtime fallback is deliberately bounded to one refinement level:
  // full frame + four overlapping quadrants. This covers the 1/2/4-lane
  // sender layouts without the old 4x4 (16-region) explosion.
  // 0 = full-frame only; 1 = full-frame + four recovery regions.
  // Do not force depth=1: the receiver uses depth=0 for the high-frequency
  // acquisition path and enables regional recovery only after misses.
  const maxDepth=Math.max(0,Math.min(1,request.maxDepth??1));

  const add=(value?:string, location?:{topLeftCorner?:{x:number;y:number};topRightCorner?:{x:number;y:number};bottomLeftCorner?:{x:number;y:number};bottomRightCorner?:{x:number;y:number}})=>{
    if(!value)return;
    const key=keyFor(value);
    if(localSeen.has(key))return;
    localSeen.add(key);
    values.push(value);
    if(location){
      const points=[location.topLeftCorner,location.topRightCorner,location.bottomLeftCorner,location.bottomRightCorner].filter((point):point is {x:number;y:number}=>Boolean(point));
      if(points.length>=2){
        const xs=points.map(point=>point.x);
        const ys=points.map(point=>point.y);
        boxes.push({x:Math.max(0,Math.min(...xs)),y:Math.max(0,Math.min(...ys)),width:Math.max(1,Math.max(...xs)-Math.min(...xs)),height:Math.max(1,Math.max(...ys)-Math.min(...ys))});
      }
    }
  };

  // Reuse one worker-local scratch buffer for cropped regions. The previous
  // implementation allocated a fresh Uint8ClampedArray for every region,
  // creating avoidable GC pressure during long camera sessions.
  let scratch=new Uint8ClampedArray(0);

  const inspect=(x:number,y:number,width:number,height:number)=>{
    const clippedWidth=Math.max(1,Math.min(width,request.width-x));
    const clippedHeight=Math.max(1,Math.min(height,request.height-y));
    regionsScanned+=1;

    try{
      // The full-frame region is already contiguous. Do not copy the entire
      // camera frame just to pass it to jsQR.
      if(x===0 && y===0 && clippedWidth===request.width && clippedHeight===request.height){
        // Fast path: normal black-on-white QR first. jsQR documents that
        // attemptBoth costs about 50% more work. Only pay that cost when the
        // normal polarity fails.
        // The sender always emits standard black-on-white QR modules.
        // Keep the hot path to one jsQR attempt. Inversion is reserved for
        // recovery crops so a missed normal QR does not double every decode.
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
      if(fast) add(fast.data,{topLeftCorner:{x:fast.location.topLeftCorner.x+x,y:fast.location.topLeftCorner.y+y},topRightCorner:{x:fast.location.topRightCorner.x+x,y:fast.location.topRightCorner.y+y},bottomLeftCorner:{x:fast.location.bottomLeftCorner.x+x,y:fast.location.bottomLeftCorner.y+y},bottomRightCorner:{x:fast.location.bottomRightCorner.x+x,y:fast.location.bottomRightCorner.y+y}});
      else if(maxDepth>=1){
        const recovered=jsQR(crop,clippedWidth,clippedHeight,{inversionAttempts:'attemptBoth'});
        if(recovered) add(recovered.data,{topLeftCorner:{x:recovered.location.topLeftCorner.x+x,y:recovered.location.topLeftCorner.y+y},topRightCorner:{x:recovered.location.topRightCorner.x+x,y:recovered.location.topRightCorner.y+y},bottomLeftCorner:{x:recovered.location.bottomLeftCorner.x+x,y:recovered.location.bottomLeftCorner.y+y},bottomRightCorner:{x:recovered.location.bottomRightCorner.x+x,y:recovered.location.bottomRightCorner.y+y}});
      }
    }catch{
      // A single bad region must never kill the camera loop.
    }
  };

  inspect(0,0,request.width,request.height);

  if(maxDepth>=1){
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
  };
}

type WorkerScope={
  onmessage:(event:MessageEvent<DecodeRequest>)=>void;
  postMessage:(message:DecodeResult)=>void;
};

const scope=self as unknown as WorkerScope;
scope.onmessage=(event)=>{
  try{scope.postMessage(decode(event.data));}
  catch{scope.postMessage({id:event.data.id,values:[],boxes:[],regionsScanned:0,processingMs:0});}
};
