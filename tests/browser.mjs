import {chromium} from 'playwright';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const server=await createServer({server:{host:'127.0.0.1',port:5174,strictPort:true}});await server.listen();
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const errors=[];let checks=0;
const check=(ok,message)=>{assert.ok(ok,message);checks++;console.log('PASS',message)};
await mkdir('docs/screenshots',{recursive:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
const nav=async(name)=>{await page.locator('nav[aria-label="Main navigation"]').getByRole('button',{name:new RegExp('^'+name)}).click();await page.getByRole('heading',{name:name+'.',exact:true}).waitFor();};
try{
 await page.goto('http://127.0.0.1:5174');await page.getByRole('heading',{name:'Command Center.'}).waitFor();
 check(await page.getByRole('button',{name:'Start Session',exact:true}).isDisabled(),'offline capture controls disabled');
 await page.getByRole('button',{name:'Connect demo OBS',exact:true}).click();await page.getByRole('button',{name:'Disconnect demo OBS',exact:true}).waitFor();
 await page.getByRole('button',{name:'Check setup',exact:true}).click();await page.getByRole('heading',{name:'Preflight results'}).waitFor();
 await page.getByRole('button',{name:'Start Session',exact:true}).click();await page.getByRole('button',{name:'End Session',exact:true}).waitFor();
 check((await page.locator('.status-bar').innerText()).includes('Recording off'),'start session does not start recording');
 await page.getByRole('button',{name:'Save Replay',exact:true}).click();await page.locator('.highlight-card').first().getByText('Highlight 4').waitFor();
 check(await page.locator('.highlight-card').count()===3,'recent replay appears in highlights');
 await page.getByRole('button',{name:'Start Recording',exact:true}).click();await page.getByRole('button',{name:'Stop Recording',exact:true}).waitFor();
 await nav('Stream Controls');await page.getByRole('button',{name:'Go Live',exact:true}).click();await page.getByRole('dialog').waitFor();
 check((await page.locator('.status-bar').innerText()).includes('Recording'),'explicit broadcast confirmation is separate from recording');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Go Live',exact:true}).click();await page.getByLabel('Destination',{exact:true}).fill('Demo · drift');await page.getByRole('button',{name:'Confirm simulated Go Live'}).click();await page.getByRole('button',{name:'Stop simulated stream'}).waitFor();await nav('Settings');await nav('Stream Controls');
 check(await page.getByRole('button',{name:'Stop simulated stream'}).isVisible(),'changing screens preserves broadcast');
 await page.getByRole('button',{name:'Stop simulated stream'}).click();
 await nav('Audio');await page.getByRole('button',{name:'Mute source',exact:true}).first().click();await page.getByRole('button',{name:'Unmute source',exact:true}).waitFor();check(true,'mixer mute state updates');
 await nav('Settings');await page.getByLabel('Game name').fill('Valorant');await page.getByLabel('Save Replay hotkey').fill('Ctrl+Shift+F10');await page.getByRole('button',{name:'Save game setup',exact:true}).click();await nav('Command Center');await page.locator('.profile-summary').getByText('Valorant').first().waitFor();check(true,'single game setup saves (profiles removed)');
 await nav('ClipForge');await page.getByRole('button',{name:'Cinematic',exact:true}).click();check(await page.getByLabel('Fade in · 400ms').isVisible(),'preset applies inspectable fade values');
 const originalOut=await page.getByLabel('Out (seconds)').inputValue();await page.getByLabel('In (seconds)').fill('2');await page.getByLabel('Out (seconds)').fill('20');await page.getByRole('button',{name:'Undo',exact:true}).click();check(await page.getByLabel('Out (seconds)').inputValue()===originalOut,'undo restores edit');await page.getByRole('button',{name:'Redo',exact:true}).click();
 await page.getByRole('button',{name:'Layout',exact:true}).click();await page.getByLabel('Aspect ratio').selectOption('9:16');check(await page.locator('.editor-preview.vertical').count()===1,'vertical preview follows edit model');
 await page.getByRole('button',{name:'Captions',exact:true}).click();await page.getByRole('button',{name:'Add caption',exact:true}).click();await page.getByLabel('Caption text').fill('A moment worth keeping.');check(await page.locator('.preview-caption').innerText()==='A moment worth keeping.','editable caption renders in preview');
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Timeline playhead').evaluate(el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'8000');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});await page.getByRole('button',{name:'Split at playhead',exact:true}).click();check(await page.locator('.timeline-segment').count()===2,'timeline splits source non-destructively');
 await page.getByRole('button',{name:'Move later',exact:true}).click();check(true,'segment reorder executes');
 await page.getByRole('button',{name:'Quick Clip',exact:true}).click();check(!await page.locator('.media-browser').isVisible(),'quick clip reduces editor chrome');await page.getByRole('button',{name:'Editor',exact:true}).click();
 await page.getByRole('button',{name:'Export clip',exact:true}).click();await page.getByLabel('Simulate encoder failure for recovery testing').check();await page.getByRole('button',{name:'Queue simulated export'}).click();await page.getByText('Simulated encoder failure',{exact:false}).waitFor();await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Simulation finished',{exact:true}).waitFor();check(true,'failed export supports retry to simulated completion');
 await page.getByRole('button',{name:'Open Output capability'}).click();await page.getByRole('status').filter({hasText:'do not create media files'}).waitFor();check(await page.getByRole('status').filter({hasText:'do not create media files'}).isVisible(),'simulated completion never claims an output file');await page.getByRole('button',{name:'Close dialog'}).click();
 await page.getByRole('button',{name:'Export clip',exact:true}).click();await page.getByLabel('Simulate encoder failure for recovery testing').uncheck();await page.getByRole('button',{name:'Queue simulated export'}).click();await page.getByRole('button',{name:'Cancel job',exact:true}).click();await page.getByText('canceled',{exact:true}).waitFor();check(true,'queue cancellation updates state');await page.getByRole('button',{name:'Close dialog'}).click();
 await page.keyboard.press('Control+k');await page.getByRole('dialog',{name:'Jump to something great'}).waitFor();await page.getByLabel('Search commands').fill('Settings');await page.keyboard.press('Tab');check(await page.evaluate(()=>document.activeElement?.tagName)==='BUTTON','palette supports keyboard focus');await page.keyboard.press('Escape');
 if(await page.getByRole('button',{name:'Dismiss notification'}).isVisible())await page.getByRole('button',{name:'Dismiss notification'}).click();await page.locator('.media-select').filter({hasText:'The final round'}).click();
 // Screenshot each route, plus requested desktop dimensions and small windows.
 for(const size of [{width:1920,height:1080},{width:1440,height:900},{width:1024,height:768},{width:390,height:844}]){
 await page.setViewportSize(size);
 if(size.width<761){await page.getByRole('button',{name:'Toggle navigation'}).click();}
 await nav('Command Center');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`docs/screenshots/command-center-${size.width}.png`,fullPage:false});
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Command Center fits ${size.width}px`);
 if(size.width<761){await page.getByRole('button',{name:'Toggle navigation'}).click();}
 await nav('ClipForge');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`docs/screenshots/clipforge-${size.width}.png`,fullPage:false});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`ClipForge fits ${size.width}px`);
 }
 await page.setViewportSize({width:1440,height:900});
 if(await page.getByRole('button',{name:'Dismiss notification'}).isVisible())await page.getByRole('button',{name:'Dismiss notification'}).click();
 for(const name of ['Sessions','Stream Controls','Audio','Settings']){await nav(name);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`docs/screenshots/${name.toLowerCase().replaceAll(' ','-')}-1440.png`,fullPage:false});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} fits desktop`);}
 const testVideo=join(tmpdir(),'drift-browser-test.webm');execFileSync('ffmpeg',['-y','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libvpx','-b:v','250k','-c:a','libopus',testVideo],{stdio:'ignore'});
 await nav('ClipForge');await page.locator('input[type=file][accept*=video]').setInputFiles(testVideo);await page.locator('.preview-heading').getByText('Local preview',{exact:true}).waitFor();check(await page.locator('video').count()===1,'local video import creates real preview');await page.getByLabel('In (seconds)').fill('0.5');await page.getByRole('button',{name:'Play preview',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0.6);check(true,'real media seeks through trimmed source playback');await page.getByRole('button',{name:'Pause playback'}).click();await page.getByText('Saved locally',{exact:true}).waitFor();await page.reload();await nav('ClipForge');await page.getByRole('heading',{name:'Media file is missing'}).waitFor();check(true,'reload preserves draft and expires temporary media handles');await page.getByRole('button',{name:'Locate recording'}).click();await page.locator('input[type=file][accept*=video]').setInputFiles(testVideo);await page.locator('.preview-heading').getByText('Local preview',{exact:true}).waitFor();check(true,'missing local recording can be relinked');
 await nav('Settings');await page.getByRole('button',{name:'Diagnostics',exact:true}).click();await page.getByRole('button',{name:'missing',exact:true}).click();await nav('ClipForge');await page.locator('.media-select').first().click();await page.getByRole('heading',{name:'Media file is missing'}).waitFor();check(true,'missing media offers relink flow');
 await nav('Settings');await page.getByRole('button',{name:'Diagnostics',exact:true}).click();await page.getByRole('button',{name:'empty',exact:true}).click();await nav('Command Center');await page.getByRole('heading',{name:'Your highlights live here'}).waitFor();check(true,'empty library has useful next action');
 check(errors.length===0,'no runtime page errors');
 await writeFile('docs/browser-verification.json',JSON.stringify({checks,errors,viewports:['1920×1080','1440×900','1024×768','390×844'],browser:'Chromium 134 / Playwright 1.51.1',scope:'Browser demo only'},null,2));
 console.log(`Verified ${checks} browser checks.`);
}finally{await browser.close();await server.close();}
