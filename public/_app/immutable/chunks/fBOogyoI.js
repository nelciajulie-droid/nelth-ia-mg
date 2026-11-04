import"./CWj6FrbW.js";import"./69_IOA4Y.js";import{p as je,g as Ne,m as L,o as Ue,l as a,k as l,x as $e,y as ue,z as Ge,A as Oe,c as y,r as h,n as Y,t as ee,B as A,a as W,d as He,q as ge,b as Xe,e as te,s as Ke,F as oe,f as B,aR as Ze}from"./cLlIXn7l.js";import{i as Je}from"./BeF-9El8.js";import{e as Pe,i as Qe}from"./BgjZNqcJ.js";import{s as q,b as Ye,a as me}from"./B3LWqNn3.js";import{b as et}from"./CzZt1Tfu.js";import{i as tt}from"./BiTGkzn6.js";import{p}from"./ZvJmMv5w.js";import{t as z}from"./CGgohGH9.js";import{r as ve,E as ot,c as rt,i as at,$ as it}from"./_waXOR9c.js";import{t as nt}from"./BouA_jq4.js";import{X as st}from"./BPYYtz_3.js";var ct=B('<div class="flex items-center h-full"><div></div></div>'),lt=B(`<div class=" text-gray-500 rounded-full cursor-not-allowed"><svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><style>.spinner_OSmW {
								transform-origin: center;
								animation: spinner_T6mA 0.75s step-end infinite;
							}
							@keyframes spinner_T6mA {
								8.3% {
									transform: rotate(30deg);
								}
								16.6% {
									transform: rotate(60deg);
								}
								25% {
									transform: rotate(90deg);
								}
								33.3% {
									transform: rotate(120deg);
								}
								41.6% {
									transform: rotate(150deg);
								}
								50% {
									transform: rotate(180deg);
								}
								58.3% {
									transform: rotate(210deg);
								}
								66.6% {
									transform: rotate(240deg);
								}
								75% {
									transform: rotate(270deg);
								}
								83.3% {
									transform: rotate(300deg);
								}
								91.6% {
									transform: rotate(330deg);
								}
								100% {
									transform: rotate(360deg);
								}
							}</style><g class="spinner_OSmW"><rect x="11" y="1" width="2" height="5" opacity=".14"></rect><rect x="11" y="1" width="2" height="5" transform="rotate(30 12 12)" opacity=".29"></rect><rect x="11" y="1" width="2" height="5" transform="rotate(60 12 12)" opacity=".43"></rect><rect x="11" y="1" width="2" height="5" transform="rotate(90 12 12)" opacity=".57"></rect><rect x="11" y="1" width="2" height="5" transform="rotate(120 12 12)" opacity=".71"></rect><rect x="11" y="1" width="2" height="5" transform="rotate(150 12 12)" opacity=".86"></rect><rect x="11" y="1" width="2" height="5" transform="rotate(180 12 12)"></rect></g></svg></div>`),dt=B('<button id="confirm-recording-button" type="button" class="p-1.5 bg-indigo-500 text-white dark:bg-indigo-500 dark:text-blue-950 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="size-4"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"></path></svg></button>'),ft=B('<div><div class="flex items-center mr-1"><button type="button"><!></button></div> <div class="flex flex-1 self-center items-center justify-between ml-2 mx-1 overflow-hidden h-6" dir="rtl"><div class="flex items-center gap-0.5 h-6 w-full max-w-full overflow-hidden overflow-x-hidden flex-wrap"></div></div> <div class="flex"><div class="  mx-1.5 pr-1 flex justify-center items-center"><div> </div></div> <div class="flex items-center"><!></div></div></div>');function Rt(we,m){je(m,!1);const b=()=>te(ye,"$i18n",V),re=()=>te(rt,"$config",V),F=()=>te(at,"$settings",V),[V,he]=Ke();ve.extend(ot);const ye=Ne("i18n");let u=p(m,"recording",12,!1),ae=p(m,"transcribe",8,!0),pe=p(m,"displayMedia",8,!1),be=p(m,"echoCancellation",8,!0),ke=p(m,"noiseSuppression",8,!0),xe=p(m,"autoGainControl",8,!0),_e=p(m,"className",8," p-2.5 w-full max-w-full"),j=p(m,"onCancel",8,()=>{}),N=p(m,"onConfirm",8,e=>{}),c=L(!1),T=!1,D=L(0),U=null,I="";const Se=()=>{U=setInterval(()=>{Ze(D)},1e3)},Re=()=>{clearInterval(U),l(D,0)},Ce=e=>{const o=Math.floor(e/60),t=e%60,s=t<10?`0${t}`:t;return`${o}:${s}`};let R=null;const ie=async()=>{if("wakeLock"in navigator)try{R=await navigator.wakeLock.request("screen"),R.addEventListener("release",()=>{})}catch(e){}},$=async()=>{if(R){try{await R.release()}catch(e){}R=null}};let g,k=null,f,v,S=[];const Me=-45;let x=300,n=L(Array(x).fill(0));const Ee=e=>{let o=0;for(let t=0;t<e.length;t++){const s=(e[t]-128)/128;o+=s*s}return Math.sqrt(o/e.length)},Le=e=>{e=e*10;const t=Math.pow(e,1.5);return Math.min(1,Math.max(.01,t))},G=()=>{k==null||k.close(),k=null},Ae=e=>{k=new AudioContext;const o=k.createMediaStreamSource(e),t=k.createAnalyser();t.minDecibels=Me,o.connect(t);const s=t.frequencyBinCount,r=new Uint8Array(s),i=new Uint8Array(t.fftSize);(()=>{const w=()=>{if(!(!u()||a(c))){if(u()&&!a(c)){t.getByteTimeDomainData(i),t.getByteFrequencyData(r);const _=Ee(i);a(n).push(Le(_)),a(n).length>=x&&a(n).shift(),l(n,a(n))}window.requestAnimationFrame(w)}};window.requestAnimationFrame(w)})()},Te=async(e,o="wav")=>{var s,r,i,d,w,_;await oe();const t=it(e,`Recording-${ve().locale(b().language).format("L LT")}.${o}`);if(ae()){if(re().audio.stt.engine==="web"||(((i=(r=(s=F())==null?void 0:s.audio)==null?void 0:r.stt)==null?void 0:i.engine)??"")==="web")return;const Q=await nt(localStorage.token,t,(_=(w=(d=F())==null?void 0:d.audio)==null?void 0:w.stt)==null?void 0:_.language).catch(Ve=>(z.error(`${Ve}`),null));Q&&N()(Q)}else N()({file:t,blob:e})},De=async()=>{var o,t,s;l(c,!0);try{if(pe()){const r=await navigator.mediaDevices.getDisplayMedia({audio:!0});g=new MediaStream;for(const i of r.getAudioTracks())g.addTrack(i);for(const i of r.getVideoTracks())i.stop()}else g=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:be(),noiseSuppression:ke(),autoGainControl:xe()}})}catch(r){z.error(b().t("Error accessing media devices.")),l(c,!1),u(!1);return}const e=["audio/webm; codecs=opus","audio/webm","audio/ogg; codecs=opus","audio/mp4","audio/wav"];v=new MediaRecorder(g,{mimeType:e.find(r=>MediaRecorder.isTypeSupported(r))}),v.onstart=async()=>{var r,i;l(c,!1),Se(),(document.activeElement===document.body||!((r=document.activeElement)!=null&&r.checkVisibility()))&&(await oe(),(i=document.getElementById("confirm-recording-button"))==null||i.focus()),await ie(),S=[],Ae(g)},v.ondataavailable=r=>S.push(r.data),v.onstop=async()=>{var r;if(T){let i=((r=S[0])==null?void 0:r.type)||v.mimeType||"audio/webm",d=i.split("/")[1].split(";")[0]||"webm";i.startsWith("audio/")||(d="webm");const w=new Blob(S,{type:i});await Te(w,d),T=!1,l(c,!1)}S=[],u(!1)};try{v.start()}catch(r){z.error(b().t("Error starting recording.")),l(c,!1),u(!1);return}if(ae()&&(re().audio.stt.engine==="web"||(((s=(t=(o=F())==null?void 0:o.audio)==null?void 0:t.stt)==null?void 0:s.engine)??"")==="web")&&("SpeechRecognition"in window||"webkitSpeechRecognition"in window)){I="",f=new(window.SpeechRecognition||window.webkitSpeechRecognition),f.continuous=!0,f.interimResults=!0;const r=2e3;let i;f.start(),f.onresult=async d=>{var w;clearTimeout(i);for(const _ of Array.from(d.results).slice(d.resultIndex))_.isFinal&&(I=`${I}${_[0].transcript}`);await oe(),(w=document.getElementById("chat-input"))==null||w.focus(),i=setTimeout(()=>{f.stop()},r)},f.onend=function(){ne(),N()({text:I}),T=!1,l(c,!1)},f.onerror=function(d){z.error(b().t("Speech recognition error: {{error}}",{error:d.error})),j()(),O()}}},O=async()=>{f&&(f.onend=null),await H()},H=async()=>{u()&&v&&await v.stop(),f&&f.stop(),await $(),Re(),S=[],l(n,Array(x).fill(0)),g&&g.getTracks().forEach(o=>o.stop()),g=null,G()},ne=async()=>{l(c,!0),T=!0,u()&&v&&await v.stop(),clearInterval(U),await $(),g&&g.getTracks().forEach(o=>o.stop()),g=null,G()};let X,K=L(),Ie=L(300);const se=e=>{u()&&e.key==="Escape"&&(e.preventDefault(),O(),j()())},ce=async()=>{u()&&document.visibilityState==="visible"&&await ie()};Ue(()=>{window.addEventListener("keydown",se),document.addEventListener("visibilitychange",ce),X=new ResizeObserver(()=>{x=Math.floor(window.innerWidth/4),a(n).length>x?l(n,a(n).slice(a(n).length-x)):l(n,Array(x-a(n).length).fill(0).concat(a(n)))}),X.observe(document.body)}),$e(()=>{window.removeEventListener("keydown",se),document.removeEventListener("visibilitychange",ce),H(),$(),G(),X.disconnect()}),ue(()=>Ge(u()),()=>{u()?De():H()}),ue(()=>a(K),()=>{l(Ie,Math.floor(a(K)/5))}),Oe(),tt();var C=ft(),Z=y(C),M=y(Z),We=y(M);st(We,{className:"size-4"}),h(M),h(Z);var E=Y(Z,2),le=y(E);Pe(le,5,()=>(a(n),A(()=>a(n).slice().reverse())),Qe,(e,o)=>{var t=ct(),s=y(t);h(t),ee(r=>{q(s,1,`w-[0.125rem] shrink-0
                    
                    ${a(c)?" bg-gray-500 dark:bg-gray-400   ":"bg-indigo-500 dark:bg-indigo-400  "} 
                    
                    inline-block h-full`),Ye(s,`height: ${r??""}%;`)},[()=>(a(o),A(()=>Math.min(100,Math.max(14,a(o)*100))))]),W(e,t)}),h(le),h(E);var de=Y(E,2),J=y(de),P=y(J),qe=y(P,!0);h(P),h(J);var fe=Y(J,2),ze=y(fe);{var Be=e=>{var o=lt();W(e,o)},Fe=e=>{var o=dt();ee(t=>me(o,"aria-label",t),[()=>(b(),A(()=>b().t("Confirm recording")))]),ge("click",o,async()=>{await ne()}),W(e,o)};Je(ze,e=>{a(c)?e(Be):e(Fe,-1)})}h(fe),h(de),h(C),ee((e,o)=>{q(C,1,`${a(c)?" bg-gray-100/50 dark:bg-gray-850/50":"bg-indigo-300/10 dark:bg-indigo-500/10 "} rounded-full flex justify-between ${_e()??""}`,"svelte-nkn4fu"),q(M,1,`p-1.5

            ${a(c)?" bg-gray-200 dark:bg-gray-700/50":"bg-indigo-400/20 text-indigo-600 dark:text-indigo-300 "} 


             rounded-full`),me(M,"aria-label",e),E.dir=E.dir,q(P,1,`text-sm
        
        
        ${a(c)?" text-gray-500  dark:text-gray-400  ":" text-indigo-400 "} 
       font-normal flex-1 mx-auto text-center`),He(qe,o)},[()=>(b(),A(()=>b().t("Cancel"))),()=>(a(D),A(()=>Ce(a(D))))]),ge("click",M,async()=>{O(),j()()}),et(C,"clientWidth",e=>l(K,e)),W(we,C),Xe(),he()}export{Rt as V};
//# sourceMappingURL=fBOogyoI.js.map
