'use strict';
// Shared vocab for the relay: streaming services (keys match the TV's js/apps.js), TMDB provider ids (US), genres, moods.
const PLATFORMS = {
  netflix: { name: 'Netflix', providers: [8, 1796], words: ['netflix'] },
  hbomax: { name: 'HBO Max', providers: [1899, 384], words: ['hbo max', 'hbomax', 'hbo', 'max'] },
  prime: { name: 'Prime Video', providers: [9, 119, 2100], words: ['prime video', 'amazon prime', 'prime', 'amazon'] },
  hulu: { name: 'Hulu', providers: [15], words: ['hulu'] },
  appletv: { name: 'Apple TV+', providers: [350], words: ['apple tv plus', 'apple tv+', 'apple tv', 'apple'] },
  peacock: { name: 'Peacock', providers: [386, 387], words: ['peacock'] },
  disney: { name: 'Disney+', providers: [337], words: ['disney plus', 'disney+', 'disney'] },
  youtube: { name: 'YouTube', providers: [], words: ['youtube'] }
};
const PROVIDER_TO_APP = {};
Object.keys(PLATFORMS).forEach(k => PLATFORMS[k].providers.forEach(id => { PROVIDER_TO_APP[id] = k; }));
const ALL_PROVIDERS = [].concat.apply([], Object.keys(PLATFORMS).map(k => PLATFORMS[k].providers));

// genre name -> TMDB ids { movie, tv } (TV has no horror/thriller/romance ids; nearest real TV genre used)
const GENRES = {
  comedy: { movie: 35, tv: 35 }, horror: { movie: 27, tv: 9648 }, action: { movie: 28, tv: 10759 },
  adventure: { movie: 12, tv: 10759 }, animation: { movie: 16, tv: 16 }, crime: { movie: 80, tv: 80 },
  documentary: { movie: 99, tv: 99 }, drama: { movie: 18, tv: 18 }, family: { movie: 10751, tv: 10751 },
  fantasy: { movie: 14, tv: 10765 }, history: { movie: 36, tv: 10768 }, music: { movie: 10402, tv: null },
  mystery: { movie: 9648, tv: 9648 }, romance: { movie: 10749, tv: 18 }, 'sci-fi': { movie: 878, tv: 10765 },
  thriller: { movie: 53, tv: 80 }, war: { movie: 10752, tv: 10768 }, western: { movie: 37, tv: 37 },
  reality: { movie: null, tv: 10764 }, kids: { movie: 10751, tv: 10762 }
};
const GENRE_NAMES = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama',
  10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 10770: 'TV Movie' };
// spoken words -> genre keys (order matters: longer phrases first)
const MOODS = [
  [/\b(true crime)\b/, ['crime', 'documentary']], [/\b(feel[- ]?good|uplifting|wholesome|cozy|cosy|heart ?warming|light)\b/, ['comedy', 'family']],
  [/\b(date night|romantic|romance|rom[- ]?com|love stor(y|ies))\b/, ['romance']],
  [/\b(funny|hilarious|comed(y|ies)|laugh|sitcoms?)\b/, ['comedy']], [/\b(scary|horror|creepy|spooky|terrifying|frightening)\b/, ['horror']],
  [/\b(thrillers?|suspense(ful)?|tense|edge of my seat)\b/, ['thriller']], [/\b(action|exciting|explosions?|action[- ]packed)\b/, ['action']],
  [/\b(sci[- ]?fi|science fiction|space|mind[- ]?bending|futuristic)\b/, ['sci-fi']], [/\b(fantasy|magic(al)?|dragons?)\b/, ['fantasy']],
  [/\b(documentar(y|ies)|docs?|docuseries)\b/, ['documentary']], [/\b(animated|animation|anime|cartoons?)\b/, ['animation']],
  [/\b(kids?|children|family)\b/, ['family']], [/\b(mystery|mysteries|whodunn?its?|detective)\b/, ['mystery']],
  [/\b(crime|heist|gangsters?|mob)\b/, ['crime']], [/\b(drama|dramas|sad|tear ?jerker|emotional)\b/, ['drama']],
  [/\b(war)\b/, ['war']], [/\b(westerns?)\b/, ['western']], [/\b(reality)\b/, ['reality']], [/\b(adventure)\b/, ['adventure']],
  [/\b(histor(y|ical)|period piece)\b/, ['history']], [/\b(musicals?)\b/, ['music']]
];
module.exports = { PLATFORMS, PROVIDER_TO_APP, ALL_PROVIDERS, GENRES, GENRE_NAMES, MOODS };
