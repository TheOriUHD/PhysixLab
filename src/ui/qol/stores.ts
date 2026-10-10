/** The browser-backed QoL stores, created on first use (the logic classes are DOM-free and tested on their own). */
import { FavouritesStore } from './favourites';
import { RecentsStore } from './recents';
import { browserStorage } from './storage';
import { ThumbStore } from './thumbs';

let recents: RecentsStore | null = null;
let favourites: FavouritesStore | null = null;
let thumbs: ThumbStore | null = null;

export const recentScenes = (): RecentsStore => (recents ??= new RecentsStore(browserStorage()));
export const favouriteStore = (): FavouritesStore => (favourites ??= new FavouritesStore(browserStorage()));
export const thumbStore = (): ThumbStore => (thumbs ??= new ThumbStore(browserStorage()));
