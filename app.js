import * as Store from './modules/storage.js';
import * as Library from './modules/library.js';
import * as Lyrics from './modules/lyrics.js';
import * as Video from './modules/video.js';
import * as Media from './modules/media.js';
import { byId as $, button, formatTime, hideModal, notify, showModal, textElement } from './modules/ui.js';

const audio = new Audio();
audio.preload = 'metadata';
audio.crossOrigin = 'anonymous';
let songs = [];
let view = 'home';
let activePlaylistId = '';
let activeSong = null;
let activeSongUrl = '';
let shuffle = false;
let repeat = 'off';
let searchTerm = '';
let sort = 'title';
let searchTimer = 0;
let sleepTimer = 0;
let lastPositionSave = 0;
let libraryPollTimer = 0;
let librarySignature = '';
let lastViewTrigger = null;
let videoResumePosition = 0;
let videoWasPlaying = false;
let userVolumeBeforeMute = 75;
let lyricsOffset = 0;
let installPrompt = null;
let volumeBeforeMute = 75;
let networkAccessEnabled = false;
let playlistEditingId = '';
let activeLyricsState = 'idle';
let activeSyncedLines = [];
let shuffleBag = [];

const initialSettings = Store.getState();
shuffle = initialSettings.shuffle;
repeat = initialSettings.repeat;
sort = initialSettings.sort || 'title';

function shuffledSongs(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const random = Math.floor(Math.random() * (index + 1));
    [result[index], result[random]] = [result[random], result[index]];
  }
  return result;
}

function setConnectionStatus(online) {
  const state = $('connection-state');
  state.classList.toggle('is-offline', !online);
  state.querySelector('span:last-child').textContent = online ? 'LOCAL LIBRARY' : 'OFFLINE · LOCAL MUSIC READY';
}

function movePlaylistSong(songId, direction) {
  const playlists = Store.getState().playlists;
  const playlist = playlists.find((item) => item.id === activePlaylistId);
  if (!playlist) return;
  const items = [...playlist.songs];
  const index = items.indexOf(songId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]];
  Store.setSetting('playlists', playlists.map((item) => item.id === playlist.id ? { ...item, songs: items } : item));
  renderSongTable();
  renderPlaylistView();
}

function removeFromPlaylist(songId) {
  const playlists = Store.getState().playlists;
  Store.setSetting('playlists', playlists.map((playlist) => playlist.id === activePlaylistId
    ? { ...playlist, songs: playlist.songs.filter((id) => id !== songId) }
    : playlist));
  renderSongTable();
  renderPlaylistView();
}

function currentCollection() {
  if (view === 'favorites') return songs.filter((song) => initialSettings.favorites.includes(song.id));
  if (view === 'recent') return Store.getState().recent.map((id) => songs.find((song) => song.id === id)).filter(Boolean);
  if (view === 'albums') {
    const albumName = searchTerm;
    if (albumName) return songs.filter((song) => song.album === albumName);
    const albums = new Map();
    for (const song of songs) if (!albums.has(song.album)) albums.set(song.album, song);
    return [...albums.values()];
  }
  if (view === 'playlist' && activePlaylistId) {
    const playlist = Store.getState().playlists.find((item) => item.id === activePlaylistId);
    return (playlist?.songs || []).map((id) => songs.find((song) => song.id === id)).filter(Boolean);
  }
  return songs;
}

function sortedSongs(collection = currentCollection()) {
  const filtered = searchTerm && view !== 'albums'
    ? collection.filter((song) => `${song.title} ${song.album} ${song.artist} ${song.year}`.toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase()))
    : collection;
  if (view === 'playlist') return filtered;
  if (view === 'albums' && searchTerm) {
    return [...filtered].sort((a, b) => (a.track || Number.MAX_SAFE_INTEGER) - (b.track || Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title));
  }
  return [...filtered].sort((a, b) => {
    if (sort === 'album') return a.album.localeCompare(b.album) || a.title.localeCompare(b.title);
    if (sort === 'added') return b.addedAt - a.addedAt;
    if (sort === 'duration') return b.duration - a.duration;
    return a.title.localeCompare(b.title);
  });
}

function resumeLocalAfterVideoError() {
  if (!videoWasPlaying) return;
  audio.currentTime = videoResumePosition;
  videoWasPlaying = false;
  resumeAudio();
}

function updateCovers(song) {
  const cover = Library.coverUrl(song);
  $('panel-cover').src = cover;
  $('bar-cover').src = cover;
  $('panel-cover').alt = `${song.title} album artwork`;
  $('bar-cover').alt = `${song.title} album artwork`;
  applyCoverColor($('panel-cover'), song.id);
}

function fallbackColor(id = '') {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 32% 28%)`;
}

function applyCoverColor(image, fallbackId) {
  const setFallback = () => document.documentElement.style.setProperty('--accent-bg', fallbackColor(fallbackId));
  const sample = () => {
    if (!image.naturalWidth) {
      setFallback();
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] < 32) continue;
        red += pixels[index];
        green += pixels[index + 1];
        blue += pixels[index + 2];
        count += 1;
      }
      if (!count) return setFallback();
      document.documentElement.style.setProperty('--accent-bg', `rgb(${Math.round(red / count)} ${Math.round(green / count)} ${Math.round(blue / count)})`);
    } catch (error) {
      console.warn('Could not sample cover artwork color.', error);
      setFallback();
    }
  };
  image.onload = sample;
  image.onerror = setFallback;
  if (image.complete) sample();
}

function updateSongMetadata(song, changedSong = activeSong?.id !== song.id) {
  activeSong = song;
  if (shuffle) shuffleBag = shuffleBag.filter((id) => id !== song.id);
  if (changedSong) {
    activeLyricsState = 'idle';
    activeSyncedLines = [];
    lyricsOffset = 0;
  }
  $('panel-song-title').textContent = song.title;
  $('panel-song-artist').textContent = song.artist || 'Billie Eilish';
  $('bar-song-title').textContent = song.title;
  $('bar-song-artist').textContent = song.artist || 'Billie Eilish';
  $('panel-metadata-line').textContent = `${song.album || 'Unknown album'}${song.year ? ` · ${song.year}` : ''}`;
  updateCovers(song);
  setFavoriteButtons();
  $('play-button').disabled = false;
  $('live-region').textContent = `Now playing ${song.title} by ${song.artist || 'Billie Eilish'}`;
  Media.attachMediaSession(song, {
    play: resumeAudio,
    pause: pauseAudio,
    next: playNext,
    previous: playPrevious,
    seek: (position) => { audio.currentTime = position; },
    currentTime: () => audio.currentTime
  }, Library.coverUrl(song));
  renderHome();
  renderSongTable();
  if ($('panel-lyrics').hidden === false) loadLyricsForSong(song);
}

function setFavoriteButtons() {
  const favorite = Boolean(activeSong && Store.getState().favorites.includes(activeSong.id));
  for (const id of ['panel-heart', 'bar-heart']) {
    $(id).setAttribute('aria-pressed', String(favorite));
    $(id).setAttribute('aria-label', favorite ? 'Remove from favorites' : 'Add to favorites');
    $(id).textContent = favorite ? '♥' : '♡';
  }
}

function setPlayButton(playing) {
  $('play-button').textContent = playing ? 'Ⅱ' : '▶';
  $('play-button').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  Media.setSessionPlaybackState(playing);
}

async function playSong(song, { seek = 0, addRecent = true } = {}) {
  if (!song) return;
  if (activeSong?.id === song.id && !audio.paused) {
    audio.currentTime = seek;
    return;
  }
  const previousSong = activeSong;
  const changedSong = previousSong?.id !== song.id;
  if (activeSongUrl && previousSong) Library.releaseAudioUrl(previousSong);
  try {
    activeSongUrl = Library.getStreamUrl(song);
    audio.src = activeSongUrl;
    audio.currentTime = 0;
    activeSong = song;
    if (addRecent) Store.addRecentlyPlayed(song.id);
    updateSongMetadata(song, changedSong);
    $('panel-now').scrollTop = 0;
    audio.load();
    await audio.play();
    if (seek > 0 && Number.isFinite(seek)) audio.currentTime = seek;
    setPlayButton(true);
    Media.connectVisualizer(audio, $('visualizer'));
    renderQueue();
    if (Store.getState().alwaysShowVideo && navigator.onLine) startVideoForSong(song, { automatic: true });
  } catch (error) {
    setPlayButton(false);
    if (error.name === 'NotAllowedError') {
      notify('Tap Play to allow this song to start.', 'error');
      return;
    }
    console.error('Could not play this local audio file.', error);
    notify(`Could not play "${song.title}". Check that the file still exists and is a supported format.`, 'error', 5000);
  }
}

function pauseAudio() {
  audio.pause();
  setPlayButton(false);
  Store.savePlayback(activeSong?.id, audio.currentTime);
}

async function resumeAudio() {
  if (Video.isVideoPlaying()) closeVideo({ resume: false });
  if (!activeSong) {
    const candidates = sortedSongs(songs);
    if (candidates.length) await playSong(candidates[0]);
    else notify('Add songs to your music folder to begin.');
    return;
  }
  if (!audio.src && activeSong) {
    await playSong(activeSong, { seek: initialSettings.lastPosition, addRecent: false });
    return;
  }
  try {
    await audio.play();
    setPlayButton(true);
  } catch (error) {
    console.error('Audio could not resume.', error);
    notify('Audio could not resume. Press play to try again.', 'error');
  }
}

function togglePlayback() {
  if (audio.paused) resumeAudio();
  else pauseAudio();
}

function getNextSong() {
  const queue = Store.getState().queue;
  if (queue.length) {
    const [nextId, ...rest] = queue;
    Store.saveQueue(rest);
    renderQueue();
    const queuedSong = songs.find((song) => song.id === nextId);
    if (queuedSong) return queuedSong;
    return getNextSong();
  }
  const collection = sortedSongs(songs);
  if (!collection.length) return null;
  if (!activeSong) return collection[0];
  if (shuffle && collection.length > 1) {
    if (!shuffleBag.length && repeat === 'all') {
      shuffleBag = shuffledSongs(collection.filter((song) => song.id !== activeSong?.id)).map((song) => song.id);
    }
    const nextId = shuffleBag.shift();
    return collection.find((song) => song.id === nextId) || null;
  }
  const index = collection.findIndex((song) => song.id === activeSong.id);
  if (index >= 0 && index < collection.length - 1) return collection[index + 1];
  return repeat === 'all' ? collection[0] : null;
}

function playNext() {
  const next = getNextSong();
  if (next) playSong(next);
  else {
    audio.pause();
    setPlayButton(false);
    if (repeat !== 'one') notify('That was the last song in this collection.');
  }
}

function playPrevious() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const recent = Store.getState().recent;
  const collection = sortedSongs(songs);
  const recentIndex = recent.indexOf(activeSong?.id);
  let previous = null;
  for (let index = recentIndex + 1; index < recent.length && !previous; index += 1) {
    previous = collection.find((song) => song.id === recent[index]) || songs.find((song) => song.id === recent[index]);
  }
  if (!previous && activeSong) {
    const index = collection.findIndex((song) => song.id === activeSong.id);
    previous = index > 0 ? collection[index - 1] : repeat === 'all' ? collection.at(-1) : null;
  }
  if (previous) playSong(previous);
  else if (activeSong) audio.currentTime = 0;
}

function toggleFavorite() {
  if (!activeSong) return;
  const favorite = Store.toggleFavorite(activeSong.id);
  initialSettings.favorites = Store.getState().favorites;
  setFavoriteButtons();
  renderHome();
  renderPlaylistNavigation();
  notify(favorite ? 'Added to favorites.' : 'Removed from favorites.');
}

function setShuffle(value) {
  shuffle = value;
  shuffleBag = value ? shuffledSongs(songs.filter((song) => song.id !== activeSong?.id)).map((song) => song.id) : [];
  Store.setSetting('shuffle', value);
  $('shuffle-button').setAttribute('aria-pressed', String(value));
  $('shuffle-button').setAttribute('aria-label', `Shuffle ${value ? 'on' : 'off'}`);
}

function setRepeat(value) {
  repeat = value;
  Store.setSetting('repeat', value);
  $('repeat-button').setAttribute('aria-pressed', String(value !== 'off'));
  $('repeat-button').setAttribute('aria-label', `Repeat ${value}`);
  $('repeat-button').textContent = value === 'one' ? '↻¹' : '↻';
}

function updateSeek() {
  if (!Number.isFinite(audio.duration)) return;
  $('elapsed').textContent = formatTime(audio.currentTime);
  $('duration').textContent = formatTime(audio.duration);
  $('seek').max = String(Math.max(1, Math.floor(audio.duration)));
  $('seek').value = String(Math.floor(audio.currentTime));
  $('seek').disabled = !audio.duration;
  Media.updateSessionPosition(audio);
  if (activeSong) Lyrics.updateLyricsAtTime(audio.currentTime, lyricsOffset, $('lyrics-scroll'));
  const now = Date.now();
  if (now - lastPositionSave > 2500) {
    lastPositionSave = now;
    Store.savePlayback(activeSong?.id, audio.currentTime);
  }
}

function setVolume(value) {
  audio.volume = Math.max(0, Math.min(1, Number(value) / 100));
  audio.muted = false;
  $('volume').value = String(Math.round(audio.volume * 100));
  Store.setSetting('volume', Math.round(audio.volume * 100));
  Store.setSetting('muted', false);
  $('mute-button').textContent = audio.volume > 0 ? '◖' : '◖̸';
  $('mute-button').setAttribute('aria-label', audio.volume > 0 ? 'Mute' : 'Unmute');
}

function toggleMute() {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    const restored = userVolumeBeforeMute || volumeBeforeMute || 75;
    audio.volume = restored / 100;
    $('volume').value = String(restored);
    Store.setSetting('volume', restored);
    Store.setSetting('muted', false);
  } else {
    userVolumeBeforeMute = Math.round(audio.volume * 100);
    volumeBeforeMute = userVolumeBeforeMute;
    audio.muted = true;
    Store.setSetting('muted', true);
  }
  $('mute-button').textContent = audio.muted ? '◖̸' : '◖';
  $('mute-button').setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
}

function coverCard(song, subtitle, click) {
  const card = document.createElement('article');
  card.className = `cover-card${activeSong?.id === song.id ? ' playing' : ''}`;
  const image = document.createElement('img');
  image.src = Library.coverUrl(song);
  image.alt = `${song.album || song.title} cover`;
  image.loading = 'lazy';
  const title = textElement('strong', 'cover-card-title', song.title);
  const detail = textElement('span', 'cover-card-subtitle', subtitle);
  card.append(image, title, detail);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Play ${song.title}`);
  card.addEventListener('click', click);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      click();
    }
  });
  return card;
}

function renderHome() {
  const recentIds = Store.getState().recent;
  const recent = recentIds.map((id) => songs.find((song) => song.id === id)).filter(Boolean).slice(0, 8);
  const recentGrid = $('recent-grid');
  recentGrid.replaceChildren();
  $('view-heading').firstElementChild.lastElementChild.textContent = view === 'home' ? 'Recently played' : collectionHeading();
  for (const song of recent) recentGrid.append(coverCard(song, song.artist || 'Billie Eilish', () => playSong(song)));
  if (!recent.length) recentGrid.append(textElement('p', 'empty-grid', songs.length ? 'Play a song and your recent music will show up here.' : 'Your recent songs will appear here.'));

  const albumGroups = new Map();
  for (const song of songs) {
    if (!albumGroups.has(song.album)) albumGroups.set(song.album, song);
  }
  const albumGrid = $('album-grid');
  albumGrid.replaceChildren();
  for (const [album, song] of [...albumGroups].slice(0, 10)) {
    albumGrid.append(coverCard({ ...song, title: album }, `${song.artist || 'Billie Eilish'} · Album`, () => {
      searchTerm = album;
      view = 'albums';
      showLibrary('albums', album);
    }));
  }
  if (!albumGroups.size) albumGrid.append(textElement('p', 'empty-grid', 'Album art and groups appear when your library is loaded.'));

  const favorites = Store.getState().favorites.map((id) => songs.find((song) => song.id === id)).filter(Boolean).slice(0, 8);
  const favoriteGrid = $('favorite-grid');
  favoriteGrid.replaceChildren();
  for (const song of favorites) favoriteGrid.append(coverCard(song, song.artist || 'Billie Eilish', () => playSong(song)));
  if (!favorites.length) favoriteGrid.append(textElement('p', 'empty-grid', 'Tap the heart beside a song to keep it close.'));
  $('favorites-section').hidden = view !== 'home';
  $('albums-section').hidden = view !== 'home';
  $('recent-grid').hidden = view !== 'home';
}

function collectionHeading() {
  if (view === 'favorites') return 'Your favorites';
  if (view === 'recent') return 'Recently played';
  if (view === 'albums') return `Album · ${searchTerm}`;
  if (view === 'playlist') return Store.getState().playlists.find((item) => item.id === activePlaylistId)?.name || 'Playlist';
  return view === 'search' ? 'Search results' : 'All songs';
}

function songRow(song, index) {
  const row = document.createElement('article');
  row.className = `song-row${activeSong?.id === song.id ? ' is-playing' : ''}`;
  row.setAttribute('role', 'listitem');
  row.dataset.songId = song.id;
  const number = textElement('span', 'row-index', activeSong?.id === song.id && !audio.paused ? '♫' : String(index + 1));
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'song-main';
  main.dataset.action = 'play';
  main.dataset.songId = song.id;
  main.setAttribute('aria-label', `Play ${song.title}`);
  main.style.cssText = 'min-width:0;padding:0;color:inherit;border:0;background:transparent;text-align:left';
  const cover = document.createElement('img');
  cover.className = 'song-cover';
  cover.src = Library.coverUrl(song);
  cover.alt = '';
  cover.loading = 'lazy';
  const text = document.createElement('span');
  text.className = 'song-text';
  text.append(textElement('strong', 'song-row-title', song.title), textElement('span', 'song-row-artist', song.artist || 'Billie Eilish'));
  main.append(cover, text);
  const album = textElement('span', 'song-album', song.album || 'Unknown album');
  const date = textElement('span', 'song-date', new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(song.addedAt || Date.now()));
  const duration = textElement('span', 'song-duration', song.duration ? formatTime(song.duration) : '—:—');

  const actions = document.createElement('div');
  actions.className = 'song-row-actions';
  if (view === 'playlist') {
    const playlist = Store.getState().playlists.find((item) => item.id === activePlaylistId);
    const itemIndex = playlist?.songs.indexOf(song.id) ?? -1;
    const up = button('↑', 'row-action', () => movePlaylistSong(song.id, -1), `Move ${song.title} earlier in playlist`);
    up.disabled = itemIndex <= 0;
    const down = button('↓', 'row-action', () => movePlaylistSong(song.id, 1), `Move ${song.title} later in playlist`);
    down.disabled = itemIndex < 0 || itemIndex >= playlist.songs.length - 1;
    const remove = button('×', 'row-action', () => removeFromPlaylist(song.id), `Remove ${song.title} from playlist`);
    actions.append(up, down, remove);
  }
  const favorite = button(Store.getState().favorites.includes(song.id) ? '♥' : '♡', `row-action${Store.getState().favorites.includes(song.id) ? ' is-loved' : ''}`, () => {
    Store.toggleFavorite(song.id);
    initialSettings.favorites = Store.getState().favorites;
    renderSongTable();
    renderHome();
    setFavoriteButtons();
  }, `Toggle favorite for ${song.title}`);
  favorite.dataset.action = 'favorite';
  actions.append(favorite);
  const menuWrap = document.createElement('div');
  menuWrap.className = 'row-menu';
  const more = button('⋯', 'row-action', () => showSongMenu(more, song), `More actions for ${song.title}`);
  more.dataset.action = 'menu';
  menuWrap.append(more);
  actions.append(menuWrap);
  row.append(number, main, album, date, duration, actions);
  return row;
}

function renderSongTable() {
  const list = $('song-list');
  list.replaceChildren();
  const albumIndex = view === 'albums' && !searchTerm;
  $('track-table-head').hidden = albumIndex;
  $('library-album-grid').hidden = !albumIndex;
  if (albumIndex) {
    $('library-album-grid').replaceChildren();
    const albums = new Map();
    for (const song of songs) if (!albums.has(song.album)) albums.set(song.album, song);
    if (!albums.size) $('library-album-grid').append(textElement('p', 'empty-grid', 'Albums appear as soon as your library has music.'));
    for (const [album, song] of albums) {
      $('library-album-grid').append(coverCard({ ...song, title: album }, `${song.artist || 'Billie Eilish'} · Album`, () => showLibrary('albums', album)));
    }
    return;
  }
  if (!songs.length) {
    list.append(textElement('div', 'empty-table', 'No songs here yet. Add music or select another library view.'));
    return;
  }
  const current = sortedSongs();
  if (!current.length) {
    list.append(textElement('div', 'empty-table', searchTerm ? 'No songs match your search.' : 'This collection is empty.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  current.forEach((song, index) => fragment.append(songRow(song, index)));
  list.append(fragment);
}

function showSongMenu(anchor, song) {
  document.querySelectorAll('.row-menu-popup').forEach((menu) => menu.remove());
  const popup = document.createElement('div');
  popup.className = 'row-menu-popup';
  popup.setAttribute('role', 'menu');
  const actions = [
    ['play-next', 'Play next'],
    ['queue-add', 'Add to queue'],
    ['playlist-add', 'Add to playlist']
  ];
  for (const [action, label] of actions) {
    const item = button(label, '', () => {
      if (action === 'play-next') addToQueue(song, true);
      if (action === 'queue-add') addToQueue(song);
      if (action === 'playlist-add') showPlaylistPicker(song);
      popup.remove();
    });
    item.dataset.action = action;
    popup.append(item);
  }
  anchor.closest('.row-menu').append(popup);
}

function addToQueue(song, playNext = false) {
  if (!song) return;
  const state = Store.getState();
  if (song.id === activeSong?.id || state.queue.includes(song.id)) {
    notify('That song is already playing or queued.');
    return;
  }
  Store.saveQueue(playNext ? [song.id, ...state.queue] : [...state.queue, song.id]);
  renderQueue();
  notify(playNext ? `${song.title} will play next.` : `Added ${song.title} to your queue.`);
}

function renderQueue() {
  const list = $('queue-list');
  list.replaceChildren();
  const queue = Store.getState().queue.map((id) => songs.find((song) => song.id === id)).filter(Boolean);
  if (!queue.length) {
    list.append(textElement('p', 'queue-empty', 'Your queue is clear. Add songs from the library to play them next.'));
    return;
  }
  queue.forEach((song, index) => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const cover = document.createElement('img');
    cover.src = Library.coverUrl(song);
    cover.alt = '';
    const info = document.createElement('button');
    info.type = 'button';
    info.style.cssText = 'min-width:0;padding:0;border:0;background:transparent;text-align:left';
    info.append(textElement('strong', '', song.title), textElement('small', '', song.artist || 'Billie Eilish'));
    info.addEventListener('click', () => playSong(song));
    const up = button('↑', '', () => moveQueue(index, -1), `Move ${song.title} earlier`);
    up.disabled = index === 0;
    const down = button('↓', '', () => moveQueue(index, 1), `Move ${song.title} later`);
    down.disabled = index === queue.length - 1;
    const remove = button('×', '', () => removeFromQueue(index), `Remove ${song.title} from queue`);
    row.append(cover, info, up, down, remove);
    list.append(row);
  });
}

function moveQueue(index, direction) {
  const queue = Store.getState().queue;
  const target = index + direction;
  if (target < 0 || target >= queue.length) return;
  [queue[index], queue[target]] = [queue[target], queue[index]];
  Store.saveQueue(queue);
  renderQueue();
}

function removeFromQueue(index) {
  const queue = Store.getState().queue;
  queue.splice(index, 1);
  Store.saveQueue(queue);
  renderQueue();
}

function renderPlaylistNavigation() {
  const nav = $('playlist-nav');
  nav.replaceChildren();
  for (const playlist of Store.getState().playlists) {
    const item = button(`♫  ${playlist.name}`, `nav-item${view === 'playlist' && activePlaylistId === playlist.id ? ' is-active' : ''}`, () => {
      activePlaylistId = playlist.id;
      showLibrary('playlist');
      setPanel('queue', { openOnMobile: false });
    }, `Open playlist ${playlist.name}`);
    nav.append(item);
  }
}

function createPlaylist() {
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 45;
  nameInput.placeholder = 'Give it a name';
  nameInput.setAttribute('aria-label', 'Playlist name');
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const create = button('Create playlist', '', () => {
    const name = nameInput.value.trim();
    if (!name) {
      notify('Give your playlist a name first.', 'error');
      nameInput.focus();
      return;
    }
    const state = Store.getState();
    const playlist = { id: crypto.randomUUID(), name, songs: [], createdAt: Date.now() };
    Store.setSetting('playlists', [...state.playlists, playlist]);
    activePlaylistId = playlist.id;
    view = 'playlist';
    hideModal();
    renderPlaylistNavigation();
    showLibrary('playlist');
    setPanel('queue', { openOnMobile: false });
  });
  const form = document.createElement('div');
  form.append(nameInput, actions);
  actions.append(create);
  showModal({ title: 'Create a playlist', eyebrow: 'A SOUND ALL YOUR OWN', content: form });
  nameInput.focus();
}

function showPlaylistPicker(song) {
  const choices = document.createElement('div');
  choices.className = 'modal-actions';
  const playlists = Store.getState().playlists;
  if (!playlists.length) {
    choices.append(textElement('p', 'modal-content-copy', 'Create a playlist first to start collecting songs.'));
  }
  for (const playlist of playlists) {
    choices.append(button(playlist.name, '', () => {
      const updated = Store.getState().playlists.map((item) => item.id === playlist.id && !item.songs.includes(song.id)
        ? { ...item, songs: [...item.songs, song.id] }
        : item);
      Store.setSetting('playlists', updated);
      hideModal();
      renderPlaylistNavigation();
      notify(`Added to ${playlist.name}.`);
    }));
  }
  showModal({ title: `Add ${song.title}`, eyebrow: 'CHOOSE A PLAYLIST', content: choices });
}

function managePlaylist(playlist) {
  const editor = $('playlist-editor');
  editor.hidden = false;
  editor.replaceChildren();
  const title = textElement('h3', '', playlist.name);
  const renameInput = document.createElement('input');
  renameInput.value = playlist.name;
  renameInput.maxLength = 45;
  renameInput.setAttribute('aria-label', 'Rename playlist');
  const rename = button('Rename', '', () => {
    const name = renameInput.value.trim();
    if (!name) return notify('Playlist name cannot be empty.', 'error');
    Store.setSetting('playlists', Store.getState().playlists.map((item) => item.id === playlist.id ? { ...item, name } : item));
    renderPlaylistNavigation();
    showLibrary('playlist');
  });
  const remove = button('Delete playlist', '', () => confirmAction(`Delete "${playlist.name}"? Songs will stay in your library.`, () => {
    Store.setSetting('playlists', Store.getState().playlists.filter((item) => item.id !== playlist.id));
    activePlaylistId = '';
    renderPlaylistNavigation();
    showLibrary('library');
  }));
  editor.append(title, renameInput, rename, remove);
}

function confirmAction(message, action) {
  const copy = textElement('p', 'modal-content-copy', message);
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.append(button('Cancel', '', hideModal), button('Confirm', '', () => { hideModal(); action(); }));
  const content = document.createElement('div');
  content.append(copy, actions);
  showModal({ title: 'Are you sure?', content });
}

function showLibrary(nextView, albumName = '') {
  view = nextView;
  if (nextView === 'albums') searchTerm = albumName;
  $('content-section').hidden = nextView !== 'home';
  $('library-section').hidden = nextView === 'home';
  if (nextView !== 'albums') searchTerm = nextView === 'search' ? $('search').value : '';
  const labels = {
    library: ['YOUR MUSIC', 'All songs'],
    search: ['FIND YOUR SOUND', 'Search results'],
    favorites: ['YOUR COLLECTION', 'Favorites'],
    recent: ['BACK IN ROTATION', 'Recently played'],
    albums: [albumName ? 'ALBUM' : 'YOUR COLLECTION', albumName || 'All albums'],
    playlist: ['YOUR PLAYLIST', Store.getState().playlists.find((item) => item.id === activePlaylistId)?.name || 'Playlist']
  };
  const [eyebrow, title] = labels[nextView] || labels.library;
  $('library-eyebrow').textContent = eyebrow;
  $('library-title').textContent = title;
  $('sort-select').value = sort;
  renderSongTable();
  if (nextView === 'playlist' && activePlaylistId) {
    const playlist = Store.getState().playlists.find((item) => item.id === activePlaylistId);
    if (playlist) managePlaylist(playlist);
  } else $('playlist-editor').hidden = true;
  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('is-active', item.dataset.view === nextView));
  renderHome();
}

function setPanel(tab, { openOnMobile = true } = {}) {
  const mapping = { now: 'panel-now', lyrics: 'panel-lyrics', queue: 'panel-queue' };
  for (const [key, panelId] of Object.entries(mapping)) {
    const selected = key === tab;
    $(panelId).hidden = !selected;
    $(`tab-${key}`).setAttribute('aria-selected', String(selected));
  }
  $('panel-title').textContent = tab === 'lyrics' ? 'LYRICS' : tab === 'queue' ? 'QUEUE' : 'NOW PLAYING';
  $('side-panel').classList.toggle('mobile-open', openOnMobile && window.matchMedia('(max-width: 700px)').matches);
  lastViewTrigger = tab === 'lyrics' ? $('show-lyrics') : tab === 'queue' ? $('queue-bar-button') : $('bar-expand');
  if (tab === 'lyrics' && activeSong && activeLyricsState === 'idle') loadLyricsForSong(activeSong);
  if (tab === 'queue') renderQueue();
}

function renderLyricsState(state, message = '') {
  activeLyricsState = state;
  $('lyrics-state').hidden = state === 'loaded';
  $('lyrics-scroll').hidden = true;
  $('lyrics-plain').hidden = true;
  $('lyrics-bottom').hidden = false;
  $('lyrics-retry').textContent = state === 'offline' ? '↻ Retry when online' : '↻ Retry lyrics';
  $('lyrics-source').textContent = state === 'loading' ? 'FINDING YOUR LYRICS' : 'ONLINE LYRICS';
  $('lyrics-state').replaceChildren();
  if (state === 'loading') {
    const skeleton = document.createElement('div');
    skeleton.className = 'lyrics-skeleton';
    for (let index = 0; index < 4; index += 1) skeleton.append(document.createElement('i'));
    $('lyrics-state').append(skeleton, textElement('span', '', 'Finding lyrics…'));
  } else {
    $('lyrics-state').append(textElement('span', '', message || 'Lyrics not found.'));
    if (state === 'missing') {
      const search = document.createElement('a');
      search.href = geniusSearchUrl(activeSong);
      search.target = '_blank';
      search.rel = 'noopener noreferrer';
      search.textContent = 'Search on Genius ↗';
      search.className = 'text-link';
      $('lyrics-state').append(search);
    }
  }
  $('genius-link').href = geniusSearchUrl(activeSong);
  $('genius-link').hidden = state !== 'missing';
}

function geniusSearchUrl(song) {
  return `https://genius.com/search?q=${encodeURIComponent(`${song?.artist || 'Billie Eilish'} ${song?.title || ''}`)}`;
}

async function loadLyricsForSong(song) {
  if (!song) {
    renderLyricsState('missing', 'Play a song to find its lyrics.');
    return;
  }
  activeSyncedLines = [];
  Lyrics.resetLyrics();
  await Lyrics.loadLyrics(song, ({ state, data, offset, message }) => {
    if (activeSong?.id !== song.id) return;
    lyricsOffset = offset || 0;
    if (state !== 'loaded') {
      renderLyricsState(state, message);
      return;
    }
    $('lyrics-state').hidden = true;
    $('lyrics-bottom').hidden = false;
    $('lyrics-source').textContent = `${data.source.toUpperCase()} · ONLINE`;
    $('genius-link').hidden = true;
    activeSyncedLines = data.synced;
    if (data.synced.length) {
      $('lyrics-scroll').hidden = false;
      $('lyrics-plain').hidden = true;
      $('lyrics-scroll').replaceChildren();
      data.synced.forEach((line, index) => {
        const lyric = button(line.text, 'lyric-line', () => {
          audio.currentTime = Math.max(0, line.time + lyricsOffset);
          if (audio.paused) resumeAudio();
        }, `Seek to lyric: ${line.text}`);
        lyric.dataset.time = String(line.time);
        lyric.dataset.index = String(index);
        $('lyrics-scroll').append(lyric);
      });
      $('lyrics-scroll').style.setProperty('--lyrics-size', `${$('lyrics-size').value}px`);
      Lyrics.updateLyricsAtTime(audio.currentTime, lyricsOffset, $('lyrics-scroll'));
    } else {
      $('lyrics-scroll').hidden = true;
      $('lyrics-plain').hidden = false;
      $('lyrics-plain').textContent = data.plain || 'Lyrics not found.';
      $('lyrics-source').textContent = `${data.source.toUpperCase()} · PLAIN LYRICS`;
    }
  });
}

async function adjustLyricsOffset() {
  if (!activeSong) return notify('Play a song before adjusting lyric sync.');
  const current = Number(Store.getState().offsets[activeSong.id]) || 0;
  const value = window.prompt('Lyrics sync offset in seconds. Use a negative value to show lines earlier (for example: -1.5).', String(current));
  if (value === null) return;
  const offset = Number(value);
  if (!Number.isFinite(offset) || Math.abs(offset) > 30) return notify('Enter an offset between -30 and 30 seconds.', 'error');
  const offsets = { ...Store.getState().offsets, [activeSong.id]: offset };
  Store.setSetting('offsets', offsets);
  lyricsOffset = offset;
  Lyrics.updateLyricsAtTime(audio.currentTime, lyricsOffset, $('lyrics-scroll'));
  notify(`Lyrics offset set to ${offset > 0 ? '+' : ''}${offset}s.`);
}

function closeVideo({ resume = true } = {}) {
  if (!Video.isVideoPlaying() && $('video-card').hidden) return;
  Video.closeVideo();
  $('video-card').classList.remove('is-mini');
  $('video-minimize').setAttribute('aria-pressed', 'false');
  $('video-minimize').textContent = '▱ Mini player';
  if ($('video-card').parentElement === document.body) $('panel-now').insertBefore($('video-card'), $('panel-metadata'));
  $('video-card').hidden = true;
  $('video-host').replaceChildren();
  const playerFrame = document.createElement('div');
  playerFrame.id = 'video-host';
  $('video-card').prepend(playerFrame);
  $('video-card').classList.remove('video-fullscreen-target');
  if (resume && activeSong && videoWasPlaying) {
    audio.currentTime = videoResumePosition;
    resumeAudio();
  }
  videoWasPlaying = false;
}

function showVideoMessage(message, { retry = true, searchUrl = '' } = {}) {
  $('video-card').hidden = false;
  $('video-host').replaceChildren();
  const copy = textElement('p', 'modal-content-copy', message);
  copy.style.padding = '10px';
  $('video-host').append(copy);
  if (retry) $('video-host').append(button('↻ Retry', 'video-retry', () => activeSong && startVideoForSong(activeSong)));
  if (searchUrl) {
    const search = document.createElement('a');
    search.href = searchUrl;
    search.target = '_blank';
    search.rel = 'noopener noreferrer';
    search.textContent = 'Search on YouTube ↗';
    search.className = 'text-link';
    search.style.margin = '0 10px 10px';
    $('video-host').append(search);
    resumeLocalAfterVideoError();
  }
}

async function startVideoForSong(song, { automatic = false } = {}) {
  if (!song) return;
  if (!navigator.onLine) {
    setPanel('now');
    showVideoMessage('Connect to the internet to see video.', { retry: true });
    return;
  }
  if (!automatic && $('panel-now').hidden) setPanel('now');
  Video.closeVideo();
  $('video-host').replaceChildren();
  videoResumePosition = audio.currentTime;
  videoWasPlaying = !audio.paused;
  audio.pause();
  setPlayButton(false);
  $('video-card').hidden = false;
  showVideoMessage('Finding the official music video…', { retry: false });
  try {
    const params = new URLSearchParams({ title: song.title });
    const response = await fetch(`/api/video?${params}`, { signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 503 || result.error === 'offline') {
        showVideoMessage('Connect to the internet to see video.', { retry: true });
        if (videoWasPlaying) {
          audio.currentTime = videoResumePosition;
          videoWasPlaying = false;
          resumeAudio();
        }
        return;
      }
      throw new Error(result.error || 'Video search failed.');
    }
    if (!result.videoId && !result.playlistId) {
      showVideoMessage('No video match was available.', { retry: true, searchUrl: result.searchUrl });
      return;
    }
    $('video-host').replaceChildren();
    const playerHost = document.createElement('div');
    playerHost.id = 'video-host';
    $('video-host').replaceWith(playerHost);
    const output = await Video.playVideo({
      videoId: result.videoId,
      playlistId: result.playlistId,
      title: song.title
    });
    if (output.mode === 'playlist') notify('Matching the song in your configured YouTube playlist…');
  } catch (error) {
    console.warn('Video could not be started.', error);
    if (!navigator.onLine || error instanceof TypeError || error.name === 'TimeoutError') {
      showVideoMessage('Connect to the internet to see video.', { retry: true });
    } else {
      showVideoMessage(error.message || 'Video could not be loaded.', { retry: true });
    }
    if (videoWasPlaying) {
      audio.currentTime = videoResumePosition;
      resumeAudio();
    }
  }
}

function buildSleepTimer() {
  const content = document.createElement('div');
  content.className = 'timer-options';
  content.append(textElement('p', 'modal-content-copy', 'Pause playback after a little while. Your music stays local.'));
  for (const minutes of [15, 30, 45, 60]) {
    content.append(button(`${minutes} minutes`, '', () => {
      clearTimeout(sleepTimer);
      sleepTimer = setTimeout(() => {
        pauseAudio();
        sleepTimer = 0;
        notify('Sleep timer finished. Playback paused.');
      }, minutes * 60 * 1000);
      hideModal();
      notify(`Sleep timer set for ${minutes} minutes.`);
    }));
  }
  content.append(button('Cancel timer', '', () => {
    clearTimeout(sleepTimer);
    sleepTimer = 0;
    hideModal();
    notify('Sleep timer cancelled.');
  }));
  showModal({ title: 'Sleep timer', eyebrow: 'A SOFTER LANDING', content });
}

function buildNowPlayingModal() {
  if (!activeSong) return notify('Start a song to open Now Playing.');
  const content = document.createElement('div');
  const cover = document.createElement('img');
  cover.className = 'modal-cover';
  cover.src = Library.coverUrl(activeSong);
  cover.alt = `${activeSong.title} cover`;
  const title = textElement('h3', 'modal-now-title', activeSong.title);
  const artist = textElement('p', 'modal-now-artist', activeSong.artist || 'Billie Eilish');
  const controls = document.createElement('div');
  controls.className = 'modal-player-controls';
  controls.append(button('|◀', '', playPrevious, 'Previous song'), button(audio.paused ? '▶' : 'Ⅱ', '', togglePlayback, 'Play or pause'), button('▶|', '', playNext, 'Next song'));
  content.append(cover, title, artist, controls);
  showModal({ title: 'Now Playing', eyebrow: 'IN YOUR OWN WORLD', content });
}

function buildShortcuts() {
  const rows = [
    ['Play / pause', 'Space'], ['Seek backward / forward', '← / →'], ['Volume down / up', '↓ / ↑'],
    ['Next / previous song', 'N / P'], ['Mute', 'M'], ['Shuffle', 'S'], ['Lyrics', 'L'], ['Watch video', 'V'], ['Fullscreen video', 'F']
  ];
  const content = document.createElement('div');
  content.className = 'settings-grid';
  rows.forEach(([label, key]) => {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.append(textElement('span', '', label), textElement('kbd', '', key));
    content.append(row);
  });
  showModal({ title: 'Keyboard shortcuts', eyebrow: 'KEEP THE FLOW', content });
}

function settingRow(title, detail, control) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const text = document.createElement('span');
  text.append(textElement('span', '', title), textElement('small', '', detail));
  row.append(text, control);
  return row;
}

function openSettings() {
  const content = document.createElement('div');
  content.className = 'settings-grid';
  const settings = Store.getState();
  const themeSelect = document.createElement('select');
  themeSelect.setAttribute('aria-label', 'Color theme');
  themeSelect.innerHTML = '<option value="dark">Dark</option><option value="light">Light</option>';
  themeSelect.value = settings.theme;
  themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
  content.append(settingRow('Color theme', 'Choose a calm dark or light palette.', themeSelect));

  const networkToggle = document.createElement('input');
  networkToggle.type = 'checkbox';
  networkToggle.checked = networkAccessEnabled;
  networkToggle.setAttribute('aria-label', 'Allow phone access on my Wi-Fi');
  networkToggle.addEventListener('change', () => togglePhoneAccess(networkToggle));
  content.append(settingRow('Allow phone access', 'Share this music server with devices on your Wi-Fi network only when you enable this.', networkToggle));
  fetch('/api/health').then((response) => response.ok ? response.json() : null).then((health) => {
    if (health) {
      networkAccessEnabled = Boolean(health.phoneAccessEnabled);
      networkToggle.checked = networkAccessEnabled;
    }
  }).catch((error) => console.warn('Could not read local server settings.', error));

  const videoToggle = document.createElement('input');
  videoToggle.type = 'checkbox';
  videoToggle.checked = settings.alwaysShowVideo;
  videoToggle.setAttribute('aria-label', 'Always show video when playing songs');
  videoToggle.addEventListener('change', () => Store.setSetting('alwaysShowVideo', videoToggle.checked));
  content.append(settingRow('Always show video', 'Auto-open a matching video as songs start. Local music pauses while video plays.', videoToggle));

  const rescan = button('Rescan local music', 'modal-action', () => {
    hideModal();
    rescanLibrary();
  });
  content.append(settingRow('Library', 'Look for files added to public/Billie.', rescan));
  const advanced = document.createElement('details');
  advanced.className = 'advanced-settings';
  const summary = document.createElement('summary');
  summary.textContent = 'Advanced';
  const fallback = document.createElement('div');
  fallback.className = 'advanced-setting-content';
  fallback.append(
    textElement('p', 'modal-content-copy', 'Optional browser-only fallback for opening a different local music folder.'),
    button('Open a different music folder', 'modal-action', openFolder)
  );
  advanced.append(summary, fallback);
  content.append(advanced);
  const keyboard = button('Keyboard shortcuts', 'modal-action', buildShortcuts);
  content.append(settingRow('Shortcuts', 'See all keyboard controls.', keyboard));
  showModal({ title: 'Settings', eyebrow: 'YOUR PLAYER, YOUR WAY', content });
}

async function togglePhoneAccess(input) {
  if (input.checked && !window.confirm('This makes your local song library available to other devices on your Wi-Fi network. Continue?')) {
    input.checked = false;
    return;
  }
  try {
    const response = await fetch('/api/network-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: input.checked })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Network access could not be enabled.');
    networkAccessEnabled = input.checked;
    notify(input.checked
      ? `Phone access enabled. Open http://${location.hostname === 'localhost' ? 'your-laptop-ip' : location.hostname}:${location.port || 3000} on your Wi-Fi.`
      : 'Phone access is off. The server is local to this laptop again.');
  } catch (error) {
    input.checked = networkAccessEnabled;
    console.error('Could not enable network access.', error);
    notify(error.message, 'error');
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  Store.setSetting('theme', theme);
}

async function fetchManifest(force) {
  let apiError;
  const endpoints = force ? ['/api/rescan'] : ['/api/songs'];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { cache: 'no-store', method: force ? 'POST' : 'GET' });
      if (!response.headers.get('Content-Type')?.includes('application/json')) {
        throw new TypeError('The server API is unavailable at this address.');
      }
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.message || 'The music folder could not be read.'), { status: response.status, body: result });
      if (!Array.isArray(result.songs)) throw new Error('The song list response was not valid.');
      return { ...result, source: 'server' };
    } catch (error) {
      apiError = error;
      if (error.status && error.status < 500) break;
    }
  }
  try {
    const response = await fetch(`/songs.json?updated=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Static song list returned ${response.status}.`);
    const result = await response.json();
    if (!Array.isArray(result.songs)) throw new Error('The static song list was not valid.');
    return { ...result, source: 'static' };
  } catch (error) {
    if (apiError?.body?.error === 'music_folder_missing') throw apiError;
    throw apiError || error;
  }
}

async function loadLibrary({ force = false, silent = false } = {}) {
  if (!silent) {
    $('library-skeleton').hidden = false;
    $('empty-state').hidden = true;
    $('content-section').hidden = true;
    $('library-section').hidden = true;
  }
  try {
    const result = await fetchManifest(force);
    const nextSongs = result.songs.map((song) => ({
      ...song,
      track: song.trackNumber ?? song.track ?? 0,
      source: song.fileUrl?.startsWith('/api/') ? 'server' : result.source
    }));
    const signature = JSON.stringify(nextSongs.map(({ id, title, artist, album, duration, trackNumber, year, fileUrl, coverUrl }) =>
      [id, title, artist, album, duration, trackNumber, year, fileUrl, coverUrl]));
    $('library-skeleton').hidden = true;
    $('server-notice').hidden = true;
    if (silent && signature === librarySignature) return;
    librarySignature = signature;
    songs = nextSongs;
    if (shuffle) shuffleBag = shuffledSongs(songs.filter((song) => song.id !== activeSong?.id)).map((song) => song.id);
    if (activeSong) {
      const refreshedSong = songs.find((song) => song.id === activeSong.id);
      if (refreshedSong) updateSongMetadata(refreshedSong, false);
    }
    if (!songs.length) {
      $('empty-state').hidden = false;
      $('content-section').hidden = true;
      $('library-section').hidden = true;
      $('empty-message').textContent = 'No songs found in public/Billie. Add audio files to that folder and refresh.';
    } else {
      $('empty-state').hidden = true;
      $('content-section').hidden = false;
      $('library-section').hidden = true;
      if (initialSettings.lastSongId) {
        const last = songs.find((song) => song.id === initialSettings.lastSongId);
        if (last && !activeSong) restoreLastPlayback(last);
      }
    }
    renderHome();
    renderSongTable();
    renderPlaylistNavigation();
  } catch (error) {
    $('library-skeleton').hidden = true;
    if (silent) {
      if (!navigator.onLine) setConnectionStatus(false);
      console.warn('Library refresh failed.', error);
      return;
    }
    console.error('Could not load local music library.', error);
    songs = [];
    $('empty-state').hidden = false;
    $('content-section').hidden = true;
    $('library-section').hidden = true;
    if (error.status === 503 || error.body?.error === 'music_folder_missing') {
      $('empty-message').textContent = 'No songs found in public/Billie. Add audio files to that folder and refresh.';
      $('server-notice').hidden = false;
      $('server-notice').textContent = error.message;
    } else {
      $('empty-message').textContent = 'No songs found in public/Billie. Add audio files to that folder and refresh.';
    }
  }
}

function restoreLastPlayback(song) {
  try {
    activeSong = song;
    activeSongUrl = Library.getStreamUrl(song);
    audio.src = activeSongUrl;
    audio.load();
    updateSongMetadata(song);
    const restorePosition = () => {
      const max = Number.isFinite(audio.duration) ? audio.duration : initialSettings.lastPosition;
      audio.currentTime = Math.min(initialSettings.lastPosition, max || 0);
      updateSeek();
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) restorePosition();
    else audio.addEventListener('loadedmetadata', restorePosition, { once: true });
  } catch (error) {
    console.warn('Could not restore the previous track position.', error);
  }
}

async function rescanLibrary() {
  try {
    if (songs.some((song) => song.source === 'folder')) {
      songs = await Library.requestFolderAccessAgain();
      if (shuffle) shuffleBag = shuffledSongs(songs.filter((song) => song.id !== activeSong?.id)).map((song) => song.id);
      renderHome();
      renderSongTable();
      notify(`Library refreshed · ${songs.length} songs.`);
      return;
    }
    await loadLibrary({ force: true });
    notify(`Library refreshed · ${songs.length} songs.`);
  } catch (error) {
    console.error('Could not rescan your music folder.', error);
    notify(error.message || 'Could not refresh the music folder.', 'error');
  }
}

async function openFolder() {
  try {
    songs = await Library.pickFolder();
    if (shuffle) shuffleBag = shuffledSongs(songs.filter((song) => song.id !== activeSong?.id)).map((song) => song.id);
    $('empty-state').hidden = songs.length > 0;
    $('content-section').hidden = songs.length === 0;
    $('library-section').hidden = true;
    $('server-notice').hidden = false;
    $('server-notice').textContent = 'Browser folder mode is active. Keep this browser profile to reuse folder access. Lyrics need the local app server.';
    $('empty-message').textContent = songs.length ? '' : 'No supported music files were found in that folder.';
    renderHome();
    renderSongTable();
    renderPlaylistNavigation();
    if (songs.length) notify(`Opened folder · ${songs.length} songs.`);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Could not open the selected folder.', error);
      notify(error.message, 'error');
    }
  }
}

function renderPlaylistView() {
  const playlist = Store.getState().playlists.find((item) => item.id === activePlaylistId);
  if (!playlist) return;
  const editor = $('playlist-editor');
  const heading = editor.querySelector('h3');
  if (heading) heading.textContent = `${playlist.songs.length} songs`;
}

function openFullscreen(element = $('visualizer-wrap')) {
  const target = element;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch((error) => console.warn('Could not exit fullscreen.', error));
    return;
  }
  target.requestFullscreen?.().catch((error) => {
    console.warn('Fullscreen is not available.', error);
    notify('Fullscreen is not available in this browser.', 'error');
  });
}

function handleSongClick(event) {
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const song = songs.find((item) => item.id === action.dataset.songId);
  if (action.dataset.action === 'play' && song) playSong(song);
  if (action.dataset.action === 'favorite' && song) {
    Store.toggleFavorite(song.id);
    initialSettings.favorites = Store.getState().favorites;
    renderSongTable();
    renderHome();
    setFavoriteButtons();
  }
  if (action.dataset.action === 'menu') event.stopPropagation();
}

function handleKeyboard(event) {
  if (!$('modal-backdrop').hidden || !event.key) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if ([' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) event.preventDefault();
  if (key === ' ') togglePlayback();
  if (key === 'arrowleft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  if (key === 'arrowright') audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 5);
  if (key === 'arrowup') setVolume(Math.min(100, Number($('volume').value) + 5));
  if (key === 'arrowdown') setVolume(Math.max(0, Number($('volume').value) - 5));
  if (key === 'n') playNext();
  if (key === 'p') playPrevious();
  if (key === 'm') toggleMute();
  if (key === 's') setShuffle(!shuffle);
  if (key === 'l') setPanel('lyrics');
  if (key === 'v') activeSong ? startVideoForSong(activeSong) : notify('Play a song before opening video.');
  if (key === 'f') Video.isVideoPlaying() ? Video.toggleFullscreen() : openFullscreen();
}

function setupInstallPrompt() {
  const install = $('install-app');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (ios && !navigator.standalone) {
    install.hidden = false;
    install.textContent = '＋ Add to Home Screen';
    install.addEventListener('click', () => {
      const content = textElement('p', 'modal-content-copy', 'In Safari, tap Share, then choose “Add to Home Screen” to install BILLIE on your device.');
      showModal({ title: 'Add to Home Screen', content });
    });
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    install.hidden = false;
    install.textContent = '↓ Install app';
  });
  install.addEventListener('click', async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch (error) {
      console.warn('App installation prompt could not open.', error);
    }
    installPrompt = null;
    install.hidden = true;
  });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream && !navigator.standalone) {
    install.hidden = false;
    install.textContent = '＋ Add to Home Screen';
    install.addEventListener('click', () => {
      if (!installPrompt) {
        showModal({
          title: 'Add to Home Screen',
          content: textElement('p', 'modal-content-copy', 'In Safari, tap Share, then choose “Add to Home Screen” to install BILLIE.')
        });
      }
    }, { once: true });
  }
}

function bindEvents() {
  $('play-all').addEventListener('click', () => {
    const list = sortedSongs(songs);
    if (list.length) {
      Store.saveQueue([]);
      playSong(list[0]);
    } else notify('Add music files to your library first.');
  });
  $('shuffle-all').addEventListener('click', () => {
    setShuffle(true);
    const list = sortedSongs(songs);
    if (list.length) playSong(list[Math.floor(Math.random() * list.length)]);
  });
  $('play-button').addEventListener('click', togglePlayback);
  $('previous-button').addEventListener('click', playPrevious);
  $('next-button').addEventListener('click', playNext);
  $('shuffle-button').addEventListener('click', () => setShuffle(!shuffle));
  $('repeat-button').addEventListener('click', () => setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'));
  $('panel-heart').addEventListener('click', toggleFavorite);
  $('bar-heart').addEventListener('click', toggleFavorite);
  $('seek').addEventListener('input', (event) => { audio.currentTime = Number(event.target.value); });
  $('volume').addEventListener('input', (event) => setVolume(event.target.value));
  $('mute-button').addEventListener('click', toggleMute);
  $('speed').addEventListener('change', (event) => { audio.playbackRate = Number(event.target.value); });
  $('search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      searchTerm = value.trim();
      if (searchTerm) showLibrary('search');
      else if (view === 'search') showLibrary('library');
      else renderSongTable();
    }, 180);
  });
  $('sort-select').addEventListener('change', (event) => {
    sort = event.target.value;
    Store.setSetting('sort', sort);
    renderSongTable();
  });
  $('song-list').addEventListener('click', handleSongClick);
  $('create-playlist').addEventListener('click', createPlaylist);
  $('rescan-button').addEventListener('click', rescanLibrary);
  $('rescan-library').addEventListener('click', rescanLibrary);
  $('clear-queue').addEventListener('click', () => {
    Store.saveQueue([]);
    renderQueue();
    notify('Queue cleared.');
  });
  $('show-lyrics').addEventListener('click', () => setPanel('lyrics'));
  $('lyrics-bar-button').addEventListener('click', () => setPanel('lyrics'));
  $('queue-bar-button').addEventListener('click', () => setPanel('queue'));
  document.querySelectorAll('[data-panel]').forEach((tab) => tab.addEventListener('click', () => setPanel(tab.dataset.panel)));
  document.querySelectorAll('[data-view]').forEach((item) => item.addEventListener('click', () => {
    const nextView = item.dataset.view;
    if (nextView === 'home') {
      view = 'home';
      $('content-section').hidden = false;
      $('library-section').hidden = true;
      renderHome();
    } else showLibrary(nextView);
    document.querySelectorAll('.nav-item[data-view]').forEach((nav) => nav.classList.toggle('is-active', nav.dataset.view === nextView));
  }));
  $('panel-close').addEventListener('click', () => $('side-panel').classList.remove('mobile-open'));
  $('bar-expand').addEventListener('click', buildNowPlayingModal);
  $('art-fullscreen').addEventListener('click', () => openFullscreen());
  $('video-fullscreen').addEventListener('click', () => Video.toggleFullscreen());
  $('video-minimize').addEventListener('click', () => {
    const card = $('video-card');
    const mini = !card.classList.contains('is-mini');
    if (mini) document.body.append(card);
    else $('panel-now').insertBefore(card, $('panel-metadata'));
    card.classList.toggle('is-mini', mini);
    $('video-minimize').setAttribute('aria-pressed', String(mini));
    $('video-minimize').textContent = mini ? '▱ Restore player' : '▱ Mini player';
  });
  $('video-close').addEventListener('click', () => closeVideo());
  $('watch-video').addEventListener('click', () => activeSong ? startVideoForSong(activeSong) : notify('Play a song to find its video.'));
  $('lyrics-retry').addEventListener('click', () => activeSong ? loadLyricsForSong(activeSong) : renderLyricsState('missing', 'Play a song to find its lyrics.'));
  $('offset-button').addEventListener('click', adjustLyricsOffset);
  $('lyrics-size').addEventListener('input', (event) => $('lyrics-scroll').style.setProperty('--lyrics-size', `${event.target.value}px`));
  $('sleep-button').addEventListener('click', buildSleepTimer);
  $('theme-button').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  $('settings-button').addEventListener('click', openSettings);
  $('open-settings-avatar').addEventListener('click', openSettings);
  $('modal-close').addEventListener('click', () => { hideModal(); lastViewTrigger?.focus(); });
  $('modal-backdrop').addEventListener('click', (event) => {
    if (event.target === $('modal-backdrop')) {
      hideModal();
      lastViewTrigger?.focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('modal-backdrop').hidden) {
      hideModal();
      lastViewTrigger?.focus();
    } else if (event.key === 'Escape' && Video.isVideoPlaying()) closeVideo();
    if (event.key === 'Tab' && !$('modal-backdrop').hidden) {
      const focusables = [...$('modal').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)')].filter((item) => item.getClientRects().length);
      if (!focusables.length) return;
      if (event.shiftKey && document.activeElement === focusables[0]) {
        event.preventDefault();
        focusables.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === focusables.at(-1)) {
        event.preventDefault();
        focusables[0].focus();
      }
    }
  });
  window.addEventListener('keydown', handleKeyboard);
  window.addEventListener('online', () => { setConnectionStatus(true); if (activeSong && $('panel-lyrics').hidden === false) loadLyricsForSong(activeSong); });
  window.addEventListener('offline', () => setConnectionStatus(false));
  window.addEventListener('pagehide', () => {
    Store.savePlayback(activeSong?.id, audio.currentTime);
    if (activeSongUrl && activeSong) Library.releaseAudioUrl(activeSong);
    Media.stopVisualizer();
  });
  $('nav-back').addEventListener('click', () => history.back());
  $('nav-forward').addEventListener('click', () => history.forward());
  window.addEventListener('beforeunload', () => {
    clearTimeout(searchTimer);
    clearTimeout(sleepTimer);
    clearInterval(libraryPollTimer);
  });
}

function setupVideoCallbacks() {
  Video.setVideoCallbacks({
    error: (code) => {
      const messages = {
        101: 'The video owner does not allow playback here.',
        150: 'The video owner does not allow playback here.',
        100: 'This video is unavailable or private.'
      };
      Video.closeVideo();
      showVideoMessage(`${messages[code] || 'This video could not be played.'} Local music will resume when you close it.`, { retry: true });
      resumeLocalAfterVideoError();
    },
    notFound: () => {
      Video.closeVideo();
      showVideoMessage('No matching track was found in this playlist.', { retry: true });
      const search = document.createElement('a');
      search.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(`Billie Eilish ${activeSong?.title || ''} official music video`)}`;
      search.target = '_blank';
      search.rel = 'noopener noreferrer';
      search.textContent = 'Search on YouTube ↗';
      search.className = 'text-link';
      $('video-host').append(search);
    },
    found: () => notify('Now playing the matching playlist video.'),
    finished: () => closeVideo(),
    state: (state) => {
      if (state === 1) $('video-card').classList.add('video-fullscreen-target');
    }
  });
}

async function initialize() {
  applyTheme(initialSettings.theme || 'dark');
  audio.volume = initialSettings.volume / 100;
  audio.muted = initialSettings.muted;
  userVolumeBeforeMute = initialSettings.volume || 75;
  volumeBeforeMute = userVolumeBeforeMute;
  $('volume').value = String(initialSettings.volume);
  $('sort-select').value = sort;
  setShuffle(shuffle);
  setRepeat(repeat);
  $('speed').value = '1';
  setConnectionStatus(navigator.onLine);
  bindEvents();
  setupVideoCallbacks();
  setupInstallPrompt();
  if ('serviceWorker' in navigator && (['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'https:')) {
    navigator.serviceWorker?.register('./service-worker.js').catch((error) => console.warn('Could not register the offline app shell.', error));
  }
  audio.addEventListener('play', () => {
    setPlayButton(true);
    Media.connectVisualizer(audio, $('visualizer'));
  });
  audio.addEventListener('pause', () => {
    setPlayButton(false);
    Store.savePlayback(activeSong?.id, audio.currentTime);
  });
  audio.addEventListener('timeupdate', updateSeek);
  audio.addEventListener('durationchange', () => {
    if (activeSong && !activeSong.duration && Number.isFinite(audio.duration)) {
      activeSong.duration = audio.duration;
      renderSongTable();
    }
  });
  audio.addEventListener('ended', () => {
    if (repeat === 'one') {
      audio.currentTime = 0;
      resumeAudio();
    } else playNext();
  });
  audio.addEventListener('error', () => {
    if (!activeSong) return;
    const code = audio.error?.code;
    const detail = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'unsupported audio format' : code === MediaError.MEDIA_ERR_NETWORK ? 'network or file access error' : 'file unavailable';
    notify(`Could not play ${activeSong.title}: ${detail}.`, 'error', 5000);
    setPlayButton(false);
  });
  $('library-skeleton').hidden = false;
  await loadLibrary();
  renderPlaylistNavigation();
  renderHome();
  renderQueue();
  const prior = songs.find((song) => song.id === initialSettings.lastSongId);
  if (prior && !activeSong) restoreLastPlayback(prior);
  libraryPollTimer = setInterval(() => loadLibrary({ silent: true }), 5000);
  window.billieDesktop?.onMediaKey((action) => {
    if (action === 'play-pause') togglePlayback();
    if (action === 'next') playNext();
    if (action === 'previous') playPrevious();
  });
}

initialize().catch((error) => {
  console.error('BILLIE could not start.', error);
  notify('The player could not start. Reload the page or check the server console.', 'error');
});
