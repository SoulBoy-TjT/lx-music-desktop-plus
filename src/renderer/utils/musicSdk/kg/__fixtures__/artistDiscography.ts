export const kgTokenArtistResponse = {
  info: {
    singerid: 3060,
    singername: 'Fixture Artist',
    imgurl: 'https://img.example.test/{size}/artist.jpg',
    albumcount: 5,
    songcount: 12,
    grade: 1,
  },
}

export const kgNumericArtistResponseWithoutAvatar = {
  data: {
    singerid: 3060,
    singername: 'Fixture Artist',
    albumcount: '5',
  },
  errcode: 0,
  status: 1,
}

const createAlbum = (albumid: number, albumname: string, songcount: number, imgurl?: string) => ({
  albumid,
  albumname,
  songcount,
  singerid: 3060,
  singername: 'Fixture Artist',
  publishtime: '2017-12-15',
  imgurl,
})

export const kgAlbumPageResponses = [
  {
    data: {
      total: 5,
      info: [
        createAlbum(101, 'Album A', 2, 'https://img.example.test/{size}/a.jpg'),
        createAlbum(102, 'Album B', 1),
      ],
    },
    errcode: 0,
    status: 1,
  },
  {
    data: {
      total: 5,
      info: [
        createAlbum(103, 'Album C', 3),
        createAlbum(104, 'Album D', 1),
      ],
    },
    errcode: 0,
    status: 1,
  },
  {
    data: {
      total: 5,
      info: [createAlbum(105, 'Album E', 2)],
    },
    errcode: 0,
    status: 1,
  },
]

const createRawTrack = (audioId: number, hash: string, albumId = '101') => ({
  audio_id: audioId,
  album_audio_id: audioId + 1000,
  hash,
  album_id: albumId,
  filename: `Fixture Artist - Track ${audioId}`,
})

export const kgAlbumTrackPageResponses = [
  {
    data: {
      total: 3,
      info: [
        createRawTrack(501, 'HASH_A'),
        createRawTrack(502, 'HASH_B'),
      ],
    },
    errcode: 0,
    status: 1,
  },
  {
    data: {
      total: 3,
      info: [createRawTrack(503, 'HASH_C')],
    },
    errcode: 0,
    status: 1,
  },
]

const createExpandedTrack = (songmid: number, hash: string, albumId: string | number = 101) => ({
  singer: songmid == 502 ? 'Fixture Artist、Guest Artist' : 'Fixture Artist',
  name: `Track ${songmid}`,
  albumName: 'Album A',
  albumId,
  songmid,
  source: 'kg',
  interval: '03:00',
  img: null,
  hash,
  types: [{ type: '128k', size: '3.00 MB', hash }],
  _types: {
    '128k': { size: '3.00 MB', hash },
  },
  typeUrl: {},
})

export const kgExpandedTracks = [
  createExpandedTrack(501, 'HASH_A'),
  createExpandedTrack(502, 'HASH_B'),
]

export const kgInvalidExpandedTracks = [
  { ...createExpandedTrack(503, ''), hash: '' },
  createExpandedTrack(504, 'HASH_D', 999),
]
