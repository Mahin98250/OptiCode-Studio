type DecodeResult={id:number;values:string[];boxes:Array<{x:number;y:number;width:number;height:number;corners?:Array<{x:number;y:number}>}>;regionsScanned:number;processingMs:number};

type Pending={
  workerIndex:number;
  resolve:(result:DecodeResult)=>void;
  reject:(error:Error)=>void;
};

export class QrDecodePool{
  private readonly workers:Worker[]=[];
  private readonly pending=new Map<number,Pending>();
  private readonly busy=new Set<number>();
  private readonly failed=new Set<number>();
  private nextId=1;

  constructor(size=Math.min(4,Math.max(1,((typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4)||4)-1))){
    const count=Math.max(1,Math.min(4,size));
    for(let i=0;i<count;i+=1){
      const worker=new Worker(new URL('../workers/qrDecoder.worker.ts',import.meta.url),{type:'module'});
      const workerIndex=i;
      worker.onmessage=(event:MessageEvent<DecodeResult>)=>{
        if(this.failed.has(workerIndex))return;
        const pending=this.pending.get(event.data.id);
        if(!pending)return;
        this.pending.delete(event.data.id);
        this.busy.delete(workerIndex);
        pending.resolve(event.data);
      };
      worker.onerror=()=>{
        this.busy.delete(workerIndex);
        this.failed.add(workerIndex);
        for(const [id,pending] of this.pending){
          if(pending.workerIndex!==workerIndex)continue;
          this.pending.delete(id);
          pending.reject(new Error('QR decoder worker failed.'));
        }
      };
      this.workers.push(worker);
    }
  }

  get capacity(){return this.workers.length;}
  get available(){
    return this.workers.findIndex((_,index)=>!this.failed.has(index) && !this.busy.has(index));
  }
  get busyCount(){
    return this.busy.size;
  }
  get healthyCount(){
    return this.workers.reduce((count,_,index)=>count+(this.failed.has(index)?0:1),0);
  }

  decode(buffer:ArrayBuffer,width:number,height:number,maxDepth=2):Promise<DecodeResult>|null{
    const workerIndex=this.available;
    if(workerIndex<0)return null;
    const id=this.nextId++;
    const worker=this.workers[workerIndex];
    if(!worker || this.failed.has(workerIndex))return null;
    this.busy.add(workerIndex);
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{workerIndex,resolve,reject});
      try{
        worker.postMessage({id,width,height,buffer,maxDepth},[buffer]);
      }catch(error){
        this.pending.delete(id);
        this.busy.delete(workerIndex);
        reject(error instanceof Error ? error : new Error('QR decoder worker could not accept the frame.'));
      }
    });
  }

  terminate(){
    for(const worker of this.workers)worker.terminate();
    this.pending.clear();
    this.busy.clear();
    this.failed.clear();
  }
}
