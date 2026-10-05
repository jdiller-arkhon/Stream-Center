import type {StudioSnapshot,SessionProfile} from '../shared/contracts';
/** An explicitly unconfigured form, never an invented service fixture. */
export function currentProfile(state:StudioSnapshot):SessionProfile {return state.profiles.find(p=>p.id===state.selectedProfileId)??{id:'unconfigured',name:'Set up your first profile',game:'Choose a game',gamePath:'',scene:state.obs.scenes[0]??'',destination:state.settings.mediaFolder,replayDurationMs:30000,audioPreset:'Balanced',companionApps:[],hotkey:''}}
