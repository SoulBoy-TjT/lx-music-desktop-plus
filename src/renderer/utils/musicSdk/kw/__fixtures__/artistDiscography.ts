const toPseudoJson = (value: unknown): string => JSON.stringify(value).replace(/"/g, "'")

export const kwArtistSearchResponse = toPseudoJson({
  TOTAL: '3',
  abslist: [
    {
      ARTIST: '蔡徐坤',
      ARTISTID: '192980',
      ALBUMNUM: '3',
      hts_PICPATH: 'https://img.example.test/artist.jpg',
    },
    {
      ARTIST: '蔡徐坤',
      ARTISTID: '192981',
      ALBUMNUM: '1',
      hts_PICPATH: '',
    },
    {
      ARTIST: '伊伊在想蔡徐坤',
      ARTISTID: '5667153',
      ALBUMNUM: '2',
      hts_PICPATH: '',
    },
  ],
})

export const kwFuzzyArtistSearchResponse = toPseudoJson({
  TOTAL: '1',
  abslist: [{
    ARTIST: '伊伊在想蔡徐坤',
    ARTISTID: '5667153',
    ALBUMNUM: '2',
    hts_PICPATH: '',
  }],
})

export const kwInvalidPseudoJsonResponse = "{'TOTAL':'1','abslist':[}"

const createAlbum = (
  albumid: number,
  name: string,
  musiccnt: number,
  pub: string,
) => ({
  albumid: String(albumid),
  name,
  artist: 'Fixture Artist',
  musiccnt: String(musiccnt),
  pub,
  img: `https://img.example.test/album-${albumid}.jpg`,
  hts_img: '',
})

export const kwAlbumPageResponses = [
  toPseudoJson({
    albumlist: [
      createAlbum(101, 'Album A', 3, '2017-12-15'),
      createAlbum(102, 'Album B', 1, '2018-01-01'),
    ],
    pn: '0',
    return: '2',
    total: '3',
  }),
  toPseudoJson({
    albumlist: [createAlbum(103, 'Album C', 1, '2019-02-03')],
    pn: '1',
    return: '1',
    total: '3',
  }),
]

const createTrack = (
  id: number,
  name: string,
  formats: string,
  track: number,
) => ({
  id: String(id),
  name,
  artist: id == 502 ? 'Fixture Artist&Guest Artist' : 'Fixture Artist',
  formats,
  duration: '180',
  track: String(track),
  pic: `https://img.example.test/track-${id}.jpg`,
})

export const kwAlbumTrackPageResponses = [
  toPseudoJson({
    musiclist: [
      createTrack(501, 'Track A', 'MP3128|MP3H|ALFLAC|HIRFLAC', 1),
      createTrack(502, 'Track B', 'MP3128', 2),
    ],
    songnum: '3',
    albumid: '101',
    name: 'Album A',
    artist: 'Fixture Artist',
    pub: '2017-12-15',
    img: 'https://img.example.test/album-101.jpg',
  }),
  toPseudoJson({
    musiclist: [createTrack(503, 'Track C', 'MP3H', 3)],
    songnum: '3',
    albumid: '101',
    name: 'Album A',
    artist: 'Fixture Artist',
    pub: '2017-12-15',
    img: 'https://img.example.test/album-101.jpg',
  }),
]

export const kwZeroBasedAlbumTrackResponse = toPseudoJson({
  musiclist: Array.from({ length: 19 }, (_, index) => createTrack(
    801 + index,
    `Zero Based Track ${index + 1}`,
    'MP3128',
    index,
  )),
  songnum: '19',
  albumid: '201',
  name: 'Zero Based Album',
  artist: 'Fixture Artist',
  pub: '2020-01-01',
  img: 'https://img.example.test/album-201.jpg',
})

export const kwZeroBasedAlbumTrackPageResponses = [
  toPseudoJson({
    musiclist: [
      createTrack(901, 'Paged Zero Based Track 1', 'MP3128', 0),
      createTrack(902, 'Paged Zero Based Track 2', 'MP3128', 1),
    ],
    songnum: '4',
    albumid: '202',
    name: 'Paged Zero Based Album',
    artist: 'Fixture Artist',
    img: 'https://img.example.test/album-202.jpg',
  }),
  toPseudoJson({
    musiclist: [
      createTrack(903, 'Paged Zero Based Track 3', 'MP3128', 2),
      createTrack(904, 'Paged Zero Based Track 4', 'MP3128', 3),
    ],
    songnum: '4',
    albumid: '202',
    name: 'Paged Zero Based Album',
    artist: 'Fixture Artist',
    img: 'https://img.example.test/album-202.jpg',
  }),
]

export const kwDiscontinuousZeroBasedAlbumTrackPageResponses = [
  kwZeroBasedAlbumTrackPageResponses[0],
  toPseudoJson({
    musiclist: [
      createTrack(905, 'Discontinuous Zero Based Track 3', 'MP3128', 3),
      createTrack(906, 'Discontinuous Zero Based Track 4', 'MP3128', 4),
    ],
    songnum: '4',
    albumid: '202',
    name: 'Paged Zero Based Album',
    artist: 'Fixture Artist',
    img: 'https://img.example.test/album-202.jpg',
  }),
]
