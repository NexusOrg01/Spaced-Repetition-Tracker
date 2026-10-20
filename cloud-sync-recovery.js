(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.NexusCloudSyncRecovery=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function retryDelay(attempt){
    const n=Math.max(0,Math.min(8,Math.floor(Number(attempt)||0)));
    return Math.min(300000,1500*Math.pow(2,n));
  }
  function shouldRetry(statusText){
    return !/(cloud conflict|data choice required|account queue paused|preview[^\n]*cloud sync disabled|not signed in)/i.test(String(statusText||''));
  }
  function canAutoResumePending(pending,remoteStamp){
    return !!pending&&(pending.baseServerVersion||null)===(remoteStamp||null);
  }
  return {retryDelay,shouldRetry,canAutoResumePending};
});
