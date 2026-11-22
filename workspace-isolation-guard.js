(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root&&root.document)api.install(root);
})(typeof window!=='undefined'?window:(typeof globalThis!=='undefined'?globalThis:null),function(){
  'use strict';
  const OWNER_KEY='nexus.cloud.last-user-id';
  const LAST_AUTH_KEY='nexus.cloud.last-authenticated-user-id';
  const ERROR_STATUS=/error|unavailable|conflict|failed|paused|not verified|not confirmed|choice required|verification delayed|sync delayed|timed out|retrying/i;
  function accountIdFromTitle(value){
    const match=String(value||'').match(/^Account ID:\s*(\S+)\s*$/);
    return match?match[1]:'';
  }
  function resolveWorkspaceLock(accountId,ownerId,statusText,lastAuthenticatedId,explicitOffline){
    const active=String(accountId||'').trim(),owner=String(ownerId||'').trim();
    const previous=String(lastAuthenticatedId||'').trim(),status=String(statusText||'');
    if(active){
      if(active===owner&&owner)return {locked:false,phase:'owned'};
      return {locked:true,phase:ERROR_STATUS.test(status)?'error':'loading'};
    }
    if(explicitOffline){
      if(previous&&!owner)return {locked:true,phase:'offline-unassigned'};
      if(previous&&previous!==owner)return {locked:true,phase:'offline-mismatch'};
      return {locked:false,phase:'offline'};
    }
    return {locked:true,phase:ERROR_STATUS.test(status)?'error':'initializing'};
  }
  function install(root){
    const doc=root&&root.document;
    if(!doc||typeof root.MutationObserver!=='function')return false;
    const account=doc.getElementById('cloudAccount'),status=doc.getElementById('cloudStatus');
    const overlay=doc.getElementById('workspaceIsolationLock');
    const progress=doc.getElementById('workspaceIsolationProgress');
    const heading=doc.getElementById('workspaceIsolationTitle'),message=doc.getElementById('workspaceIsolationMessage');
    const signOut=doc.getElementById('workspaceIsolationSignOut');
    const diagnostics=doc.getElementById('workspaceIsolationDiagnostics');
    const signInGoogle=doc.getElementById('workspaceIsolationSignInGoogle');
    const signInEmail=doc.getElementById('workspaceIsolationSignInEmail');
    const details=doc.getElementById('workspaceIsolationDetails'),help=doc.getElementById('cloudHelpText');
    const app=doc.querySelector('.app');
    if(!account||!overlay||!heading||!message||!signOut||!signInGoogle||!signInEmail)return false;
    let lastDiagnosticState='';
    function isPreviewOrigin(){
      const host=String(root.location&&root.location.hostname||'').toLowerCase();
      return host.endsWith('.vercel.app')||host.endsWith('.netlify.app')||host.endsWith('.pages.dev');
    }
    if(diagnostics){
      diagnostics.hidden=!isPreviewOrigin();
      diagnostics.addEventListener('click',()=>{
        const sync=root.NexusCloudSync;
        try{
          if(sync&&typeof sync.isDiagnosticsEnabled==='function'&&sync.isDiagnosticsEnabled()){
            if(typeof sync.downloadDiagnostics==='function')sync.downloadDiagnostics();
          }else if(sync&&typeof sync.enableDiagnostics==='function')sync.enableDiagnostics();
          else{
            console.warn('Nexus sync diagnostics are not ready yet. Keep the workspace screen open and try again shortly.');
          }
        }catch(error){console.warn('Nexus sync diagnostics could not be started from the workspace lock.',error);}
      });
    }
    function refresh(){
      const activeId=accountIdFromTitle(account.title);
      let ownerId='',lastAuthenticatedId='';
      try{
        if(activeId)root.localStorage.setItem(LAST_AUTH_KEY,activeId);
        ownerId=root.localStorage.getItem(OWNER_KEY)||'';
        lastAuthenticatedId=root.localStorage.getItem(LAST_AUTH_KEY)||'';
      }catch(_){}
      const accountTitle=String(account.title||''),accountText=String(account.textContent||'');
      const explicitlyOffline=/your data stays on this device while signed out/i.test(accountTitle)||
        (/preview\/local copy.*cloud sync disabled/i.test(accountText)&&/separate Supabase test project/i.test(accountTitle));
      const statusText=status?String(status.textContent||''):'';
      const decision=resolveWorkspaceLock(activeId,ownerId,statusText,lastAuthenticatedId,explicitlyOffline);
      const diagnosticState=[decision.phase,!!activeId,!!ownerId,!!activeId&&activeId===ownerId].join('|');
      if(diagnosticState!==lastDiagnosticState&&root.NexusCloudSync&&
         typeof root.NexusCloudSync.noteWorkspaceGuardState==='function'){
        lastDiagnosticState=diagnosticState;
        root.NexusCloudSync.noteWorkspaceGuardState({phase:decision.phase,
          activeAccountPresent:!!activeId,ownerPresent:!!ownerId,ownerMatches:!!activeId&&activeId===ownerId});
      }
      if(diagnostics){
        diagnostics.hidden=!isPreviewOrigin();
        const enabled=!!(root.NexusCloudSync&&typeof root.NexusCloudSync.isDiagnosticsEnabled==='function'&&root.NexusCloudSync.isDiagnosticsEnabled());
        diagnostics.textContent=enabled?'Download safe sync diagnostics':'Enable safe diagnostics and reload';
      }
      if(details){
        const helpText=help?String(help.textContent||'').trim():'';
        details.textContent=decision.locked&&decision.phase==='error'?('Status: '+statusText+(helpText?' - '+helpText:'')):'';
      }
      overlay.hidden=!decision.locked;
      overlay.setAttribute('aria-hidden',String(!decision.locked));
      overlay.dataset.state=decision.phase;
      if(progress)progress.hidden=['error','offline-mismatch','offline-unassigned'].includes(decision.phase);
      if(root.document.documentElement&&root.document.documentElement.dataset)
        root.document.documentElement.dataset.workspaceAuth=decision.locked?'pending':'ready';
      if(app)app.inert=decision.locked;
      if(decision.locked){
        signOut.hidden=!activeId;
        const showSignIn=decision.phase==='offline-mismatch'||decision.phase==='offline-unassigned'||
          (decision.phase==='error'&&!activeId);
        signInGoogle.hidden=!showSignIn;
        signInEmail.hidden=!showSignIn;
        if(decision.phase==='offline-mismatch'){
          heading.textContent="This device's workspace belongs to another account";
          message.textContent="You are signed out, but the last account used on this device does not own the saved workspace. Nexus is keeping that data hidden. Sign in to the account that owns this workspace, or reconnect and sign in again. No data has been merged or deleted.";
        }else if(decision.phase==='offline-unassigned'){
          heading.textContent='Workspace ownership could not be confirmed';
          message.textContent='Sign-in ended before Nexus could associate this local workspace with an account. The data remains stored but hidden. Sign in again to complete account verification. Nexus will not expose or upload this workspace automatically.';
        }else if(decision.phase==='error'){
          heading.textContent='Account workspace is locked';
          message.textContent=activeId
            ?"Nexus could not verify this account's workspace. The previous workspace remains stored on this device and is hidden to protect account privacy. Nexus will retry when a connection is available. You can sign out, but another account's workspace will remain hidden."
            :"Nexus could not confirm the signed-in account. Your saved workspace remains stored but hidden. Reconnect or sign in to continue. Nexus will not expose local data until the account state is confirmed.";
        }else if(decision.phase==='initializing'){
          heading.textContent='Checking account...';
          message.textContent='Nexus is confirming the sign-in state before showing study data. Your saved workspace is temporarily hidden.';
        }else{
          heading.textContent="Loading this account's workspace...";
          message.textContent='Nexus is checking your account and loading the correct study workspace. Your previous workspace stays hidden until the correct account workspace is ready.';
        }
      }else{
        signOut.hidden=true;signInGoogle.hidden=true;signInEmail.hidden=true;
      }
    }
    const observer=new root.MutationObserver(refresh);
    observer.observe(account,{attributes:true,childList:true,characterData:true,subtree:true});
    if(status)observer.observe(status,{childList:true,characterData:true,subtree:true});
    root.addEventListener('storage',refresh);
    root.addEventListener('nexus:workspace-owner-changed',refresh);
    signOut.addEventListener('click',()=>{
      const button=doc.getElementById('cloudSignOutBtn');
      if(button&&!button.disabled)button.click();
    });
    signInGoogle.addEventListener('click',()=>{
      const button=doc.getElementById('cloudGoogleSignInBtn');
      if(button&&!button.disabled)button.click();
    });
    signInEmail.addEventListener('click',()=>{
      const button=doc.getElementById('cloudEmailSignInBtn');
      if(button&&!button.disabled)button.click();
    });
    refresh();
    return true;
  }
  return {OWNER_KEY,LAST_AUTH_KEY,accountIdFromTitle,resolveWorkspaceLock,install};
});
