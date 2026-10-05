import type {ClipAsset} from '../../shared/contracts';
import {Arena} from './Artwork';
export function MediaArt({clip,variant=0}:{clip:ClipAsset;variant?:number}){return clip.thumbnailUrl?<img className="media-poster" src={clip.thumbnailUrl} alt={`Frame from ${clip.name}`}/>:clip.fixture?<Arena variant={variant} label={false}/>:<div className="thumbnail-unavailable">Preview unavailable</div>}
