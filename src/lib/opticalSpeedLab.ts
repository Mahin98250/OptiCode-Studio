export type OpticalSpeedEstimate = {
  fileBytes:number;
  payloadBytesPerFrame:number;
  frameCount:number;
  intervalMs:number;
  dwell:number;
  lanes:number;
  totalGroups:number;
  theoreticalMs:number;
  theoreticalKbps:number;
};

export function estimateOpticalSpeed(input:{
  fileBytes:number;
  payloadBytesPerFrame:number;
  intervalMs:number;
  dwell?:number;
  lanes?:number;
  finalExtraDwells?:number;
}):OpticalSpeedEstimate{
  const fileBytes=Math.max(0,Math.floor(input.fileBytes));
  const payloadBytesPerFrame=Math.max(1,Math.floor(input.payloadBytesPerFrame));
  const intervalMs=Math.max(1,Math.floor(input.intervalMs));
  const dwell=Math.max(1,Math.floor(input.dwell ?? 1));
  const lanes=Math.max(1,Math.floor(input.lanes ?? 1));
  const finalExtraDwells=Math.max(0,Math.floor(input.finalExtraDwells ?? 0));
  const frameCount=Math.max(1,Math.ceil(fileBytes/payloadBytesPerFrame));
  const totalGroups=Math.max(1,Math.ceil(frameCount/lanes));
  const opticalDwells=(Math.max(0,totalGroups-1)*dwell)+(1+finalExtraDwells);
  const theoreticalMs=opticalDwells*intervalMs;
  const theoreticalKbps=theoreticalMs>0?(fileBytes/1024)/(theoreticalMs/1000):0;
  return {fileBytes,payloadBytesPerFrame,frameCount,intervalMs,dwell,lanes,totalGroups,theoreticalMs,theoreticalKbps};
}

export function expectedRetransmissions(totalFrames:number, missingIndexes:number[]){
  const total=Math.max(0,Math.floor(totalFrames));
  return [...new Set(missingIndexes)]
    .filter(index=>Number.isInteger(index) && index>=1 && index<=total)
    .sort((a,b)=>a-b);
}

export function frameGenerationCeiling(
  bytesGenerated:number,
  durationMs:number,
){
  const safeBytes=Math.max(0,bytesGenerated);
  const safeDuration=Math.max(1,durationMs);
  return (safeBytes/1024)/(safeDuration/1000);
}
