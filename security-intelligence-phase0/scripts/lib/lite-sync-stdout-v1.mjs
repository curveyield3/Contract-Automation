import fs from 'node:fs';

// Write every byte of a child result, including very large master outputs.
// Never treat a partial write as a complete JSON envelope.
export function writeAllSyncV1(fd,value,{writer=fs.writeSync,retryLimit=12000,onRetry=()=>{}}={}){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(String(value),'utf8');
 let offset=0,retries=0;
 while(offset<bytes.length){
  try{
   const written=writer(fd,bytes,offset,bytes.length-offset);
   if(!Number.isSafeInteger(written)||written<0||written>bytes.length-offset)
     throw new Error('stdout writer returned invalid byte count');
   if(written===0){
    if(++retries>retryLimit)throw new Error('stdout writer made no progress');
    onRetry(retries);continue;
   }
   retries=0;offset+=written;
  }catch(error){
   if(!['EAGAIN','EINTR'].includes(error?.code))throw error;
   if(++retries>retryLimit)throw new Error('stdout blocked after retry budget',{cause:error});
   onRetry(retries);
  }
 }
 return bytes.length;
}
