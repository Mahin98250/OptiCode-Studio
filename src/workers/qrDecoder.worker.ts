import jsQR from 'jsqr';

type DecodeRequest = {
  id:number;
  width:number;
  height:number;
  buffer:ArrayBuffer;
  maxDepth?:number;
};

type DecodeResult = {
  id:number;
  values:string[];
  regionsScanned:number;
  processingMs:number;
};

const keyFor=(value:string)=>value.length>180?value.slice(0,180):value;

function decode(request:DecodeRequest):DecodeResult{
  const started=performance.now();
  const values:string[]=[];
  const localSeen=new Set<string>();
  let regionsScanned=0;
  const data=new Uint8ClampedArray(request.buffer);

  // The realtime fallback is deliberately bounded to one refinement level:
  // full frame + four overlapping quadrants. This covers the 1/2/4-lane
  // sender layouts without the old 4x4 (16-region) explosion.
  const maxDepth=Math.max(1,Math.min(1,request.maxDepth??1));

  const add=(value?:string)=>{
    if(!value)return;
    const key=keyFor(value);
    if(localSeen.has(key))return;
    localSeen.add(key);
    values.push(value);
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
        // OptiCode renders black modules on white. jsQR documents that
        // attemptBoth costs roughly 50% extra work, so stay on dontInvert.
        add(jsQR(data,request.width,request.height,{inversionAttempts:'attemptBoth'})?.data);
        return;
      }

      const required=clippedWidth*clippedHeight*4;
      if(scratch.length<required)scratch=new Uint8ClampedArray(required);

      for(let row=0;row<clippedHeight;row+=1){
        const from=((y+row)*request.width+x)*4;
        scratch.set(data.subarray(from,from+clippedWidth*4),row*clippedWidth*4);
      }

      add(jsQR(scratch.subarray(0,required),clippedWidth,clippedHeight,{inversionAttempts:'attemptBoth'})?.data);
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
  catch{scope.postMessage({id:event.data.id,values:[],regionsScanned:0,processingMs:0});}
};
