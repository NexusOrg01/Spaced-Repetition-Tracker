(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root&&root.document)api.install(root);
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(){
  'use strict';
  const OWNER_KEY='nexus.cloud.last-user-id';
  const ERROR_STATUS=/error|unavailable|conflict|failed|paused|not verified|not confirmed|choice required/i;
  function accountIdFromTitle(value){
    const match=String(value||'').match(/^Account ID:\s*(\S+)\s*$/);
    return match?match[1]:'';
  }
  function resolveWorkspaceLock(accountId,ownerId,statusText){
    const active=String(accountId||'').trim(),owner=String(ownerId||'').trim();
    if(!active)return {locked:false,phase:'offline'};
    if(active===owner)return {locked:false,phase:'owned'};
    return {locked:true,phase:ERROR_STATUS.test(String(statusText||''))?'error':'loading'};
  }
  function install(root){
    const doc=root&&root.document;
    if(!doc||typeof root.MutationObserver!=='function')return false;
    const account=doc.getElementById('cloudAccount');
    const status=doc.getElementById('cloudStatus');
    const overlay=doc.getElementById('workspaceIsolationLock');
    const heading=doc.getElementById('workspaceIsolationTitle');
    const message=doc.getElementById('workspaceIsolationMessage');
    const retry=doc.getElementById('workspaceIsolationRetry');
    const signOut=doc.getElementById('workspaceIsolationSignOut');
    const details=doc.getElementById('workspaceIsolationDetails');
    const help=doc.getElementById('cloudHelpText');
    const app=doc.querySelector('.app');
    if(!account||!overlay||!heading||!message||!retry||!signOut)return false;
    function refresh(){
      const activeId=accountIdFromTitle(account.title);
      let ownerId='';
      try{ownerId=root.localStorage.getItem(OWNER_KEY)||'';}catch(_){}
      const statusText=status?status.textContent:'';
      const decision=resolveWorkspaceLock(activeId,ownerId,statusText);
      if(details){
        const helpText=help?String(help.textContent||'').trim():'';
        details.textContent=decision.locked&&ERROR_STATUS.test(statusText)?('Status: '+statusText+(helpText?' — '+helpText:'')):'';
      }
      overlay.hidden=!decision.locked;
      overlay.setAttribute('aria-hidden',String(!decision.locked));
      overlay.dataset.state=decision.phase;
      if(app)app.inert=decision.locked;
      if(decision.locked){
        retry.hidden=false;
        signOut.hidden=false;
        if(decision.phase==='error'){
          heading.textContent='Account workspace is locked';
          message.textContent='Nexus could not verify this account’s workspace. Your previous workspace remains stored on this device and is hidden to protect account privacy. No cross-account merge has occurred. Retry loading this account, or sign out to return to offline mode.';
        }else{
          heading.textContent='Loading this account’s workspace…';
          message.textContent='Nexus is securely checking your account and loading the correct study workspace. Each account has its own data. Workspaces are not automatically shared or merged.';
        }
      }else{
        retry.hidden=true;
        signOut.hidden=true;
      }
    }
    const observer=new root.MutationObserver(refresh);
    observer.observe(account,{attributes:true,childList:true,characterData:true,subtree:true});
    if(status)observer.observe(status,{childList:true,characterData:true,subtree:true});
    retry.addEventListener('click',()=>root.location.reload());
    signOut.addEventListener('click',()=>{
      const button=doc.getElementById('cloudSignOutBtn');
      if(button&&!button.disabled)button.click();
      else root.location.reload();
    });
    refresh();
    return true;
  }
  return {OWNER_KEY,accountIdFromTitle,resolveWorkspaceLock,install};
});
