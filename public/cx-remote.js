(() => {
 'use strict';
 const state={devices:[],session:null,token:'',connecting:false,initialized:false,epoch:0};
 const ctx=()=>window.getRaiLocalAgentContext?.()||{};
 const text=(zh,en)=>String(ctx().language||'').startsWith('en')?en:zh;
 async function api(path,options={},token=ctx().token){
  const response=await fetch((window.RAI_API_BASE||'/api')+'/cx-remote'+path,{cache:'no-store',...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});
  const data=await response.json();if(!response.ok||data.success===false)throw Error(data.error||'cx_remote_failed');return data;
 }
 const here=()=>!!state.session&&state.token===ctx().token&&state.session.conversationId===ctx().conversationId&&state.session.status==='approved'&&state.session.expiresAt>Date.now();
 function status(message){const item=document.getElementById('localAgentMenuItem');const toggle=document.getElementById('localAgentToggle');if(item)item.dataset.status=here()?'active':'idle';toggle?.classList.toggle('active',here());if(message)window.showToast?.(message);}
 async function disable(){state.epoch++;const old=state.session,token=state.token;state.session=null;state.token='';state.connecting=false;if(old&&token)await api('/sessions/'+encodeURIComponent(old.id),{method:'DELETE'},token).catch(()=>{});status();render();}
 async function enable(deviceId){
  const context=ctx();if(!context.token)throw Error(text('请先登录','Sign in first'));
  if(!context.conversationId)throw Error(text('请先创建或打开一条已保存对话，再连接电脑','Open or create a saved conversation before connecting'));
  await disable();const epoch=++state.epoch;state.token=context.token;state.connecting=true;render();
  try{
   const data=await api('/sessions',{method:'POST',body:JSON.stringify({deviceId,conversationId:context.conversationId})},context.token);
   if(epoch!==state.epoch||ctx().token!==context.token||ctx().conversationId!==context.conversationId){await api('/sessions/'+data.session.id,{method:'DELETE'},context.token).catch(()=>{});return;}
   state.session=data.session;render();status(text('请在电脑核对安全码并允许连接','Check the code on the computer and approve'));
   for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,1000));if(epoch!==state.epoch)return;
    const update=await api('/sessions/'+state.session.id,{},context.token);
    if(ctx().token!==context.token||ctx().conversationId!==context.conversationId){await disable();return;}
    state.session=update.session;render();if(here()){status(text('在线 CX RAI 已连接；每次操作须在电脑确认','CX RAI connected; confirm each action on the computer'));return;}
   }
   throw Error('cx_remote_approval_timeout');
  }catch(error){if(epoch===state.epoch){await disable();status(text('未获电脑授权或连接已失效','Computer approval denied or connection expired'));throw error;}}
  finally{if(epoch===state.epoch){state.connecting=false;render();}}
 }
 async function refreshStatus(){
  const context=ctx();if(state.token&&state.token!==context.token)await disable();
  if(!context.token){state.devices=[];render();return;}
  const token=context.token;
  try{const data=await api('/devices',{},token);if(ctx().token!==token)return;state.devices=data.devices||[];if(state.session){try{const current=await api('/sessions/'+state.session.id);if(ctx().token===token&&state.session?.id===current.session.id)state.session=current.session;}catch{state.session=null;status();}}}
  catch{state.devices=[];}
  render();
 }
 function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',()=>Promise.resolve(fn()).catch(()=>status(text('电脑未连接；请检查本机授权与网络','Computer unavailable; check approval and network'))));return b;}
 function render(){
  const card=document.getElementById('settingsLocalAgentCard');if(!card)return;card.replaceChildren();
  const title=document.createElement('strong');title.textContent=text('连接在线 CX RAI 电脑','Connect an online CX RAI computer');
  const info=document.createElement('p');info.textContent=text('电脑：CX RAI 1.8.7+ → 设置 → 通用 → 允许同账号 Web 连接此电脑，选择工作目录并保持在线。手机无需安装扩展。连接限本对话 15 分钟；每次操作在电脑单独确认。','On the PC: CX RAI 1.8.7+ → Settings → General → enable online control and select a work folder. Keep the PC online. No phone extension required. Connections last 15 minutes for this conversation; approve each action on the PC.');
  card.append(title,info);
  if(state.session){const detail=document.createElement('p');detail.textContent=text('安全码：','Code: ')+state.session.confirmationCode+' · '+(here()?text('已连接','Connected'):text('等待电脑授权','Awaiting computer approval'));card.append(detail,button(text('断开 / 撤销','Disconnect / revoke'),disable));}
  for(const d of state.devices){const row=document.createElement('div');row.className='local-agent-device-row';const name=document.createElement('span');name.textContent=d.name+' · CX RAI '+d.version+' · '+(d.online?text('在线','Online'):text('离线','Offline'));const connect=button(text('连接当前对话','Connect this chat'),()=>enable(d.id));connect.disabled=state.connecting||!d.online;const revoke=button(text('撤销电脑连接','Revoke computer'),async()=>{await api('/devices/'+encodeURIComponent(d.id),{method:'DELETE'});await disable();await refreshStatus();});row.append(name,connect,revoke);card.append(row);}
  if(!state.devices.length){const empty=document.createElement('p');empty.textContent=text('没有在线电脑。请在同账号 Windows CX RAI 中启用；不会扫描或控制未授权设备。','No online computer. Enable this feature in Windows CX RAI signed into the same account. Unapproved devices are never scanned or controlled.');card.append(empty);}
  card.append(button(text('刷新在线设备','Refresh devices'),refreshStatus));status();
 }
 function toggle(){if(here())return disable();window.openSettings?.();window.switchSettingsSection?.('capabilities');document.getElementById('settingsLocalAgentCard')?.scrollIntoView({block:'center'});return refreshStatus();}
 function initialize(){if(state.initialized)return;state.initialized=true;const menu=document.getElementById('localAgentMenuItem');menu?.addEventListener('click',event=>{event.stopPropagation();toggle();});menu?.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle();}});refreshStatus();setInterval(()=>{if(state.session&&(ctx().conversationId!==state.session.conversationId||ctx().token!==state.token||state.session.expiresAt<=Date.now()))disable();const card=document.getElementById('settingsLocalAgentCard');if(state.session||card?.offsetParent)refreshStatus();},10000);new MutationObserver(render).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});}
 window.RaiLocalAgent=Object.freeze({initialize,enable,disable,toggle,refreshStatus,refreshActivities:async()=>{},getChatCapability:()=>here()?{protocolVersion:'cx-online-v1',sessionId:state.session.id,capabilities:['filesystem','process']}:null,handleToolCall:async()=>{throw Error('legacy_local_agent_disabled');}});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})();
