/** Browser-only media inspection. Main must probe and validate desktop media itself. */
export function readLocalVideo(url:string):Promise<{durationMs:number;thumbnailUrl:string|null}>{
 return new Promise((resolve,reject)=>{
  const video=document.createElement('video');let durationMs=0;
  const cleanup=()=>{clearTimeout(timer);video.removeAttribute('src');video.load()};
  const timer=setTimeout(()=>{cleanup();reject(new Error('Media metadata timed out. Try a browser-compatible proxy.'))},8000);
  video.preload='auto';video.muted=true;
  video.onerror=()=>{cleanup();reject(new Error('Browser cannot decode this recording. Try MP4/H.264 or WebM.'))};
  video.onloadedmetadata=()=>{durationMs=Math.round(video.duration*1000);if(!Number.isFinite(durationMs)||durationMs<1){cleanup();reject(new Error('Unsupported media duration'));return}video.currentTime=Math.min(.5,video.duration/2)};
  video.onseeked=()=>{let thumbnailUrl:string|null=null;try{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=Math.round(320*video.videoHeight/video.videoWidth);canvas.getContext('2d')?.drawImage(video,0,0,canvas.width,canvas.height);thumbnailUrl=canvas.toDataURL('image/jpeg',.72)}catch{/* Thumbnail is optional; playback can still work. */}cleanup();resolve({durationMs,thumbnailUrl})};
  video.src=url;
 });
}

/** Resolves a media handle: browser object URLs come from the renderer registry; desktop
 * handles are already app-protocol URLs (drift-media://…) served by the main process. */
export function resolveMediaUrl(handle:string|null,registry:Map<string,string>):string|undefined{
 if(!handle)return undefined;
 return registry.get(handle)??(handle.startsWith('drift-media://')?handle:undefined);
}
