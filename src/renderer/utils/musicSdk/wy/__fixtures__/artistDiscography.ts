export const wyArtistSearchResponse = {
  code: 200,
  result: {
    artists: [
      {
        id: 3060,
        name: 'Fixture Artist',
        picUrl: 'https://img.example.test/artist-search.jpg',
        albumSize: 3,
      },
      {
        id: 9999,
        name: 'Fixture Artist Tribute',
        picUrl: 'https://img.example.test/artist-fuzzy.jpg',
        albumSize: 1,
      },
    ],
  },
}

export const wyArtistResponse = {
  code: 200,
  artist: {
    id: 3060,
    name: 'Fixture Artist',
    picUrl: 'https://img.example.test/artist.jpg',
    albumSize: 3,
  },
}

const createAlbum = (id: number, name: string, size: number, publishTime: number) => ({
  id,
  name,
  size,
  publishTime,
  picUrl: `https://img.example.test/album-${id}.jpg`,
  artist: {
    id: 3060,
    name: 'Fixture Artist',
  },
})

export const wyAlbumPageResponses = [
  {
    code: 200,
    artist: {
      id: 3060,
      name: 'Fixture Artist',
      albumSize: 3,
    },
    hotAlbums: [
      createAlbum(101, 'Album A', 4, Date.UTC(2020, 0, 2)),
      createAlbum(102, 'Album B', 1, Date.UTC(2021, 2, 4)),
    ],
    more: true,
  },
  {
    code: 200,
    artist: {
      id: 3060,
      name: 'Fixture Artist',
      albumSize: 3,
    },
    hotAlbums: [
      createAlbum(103, 'Album C', 2, Date.UTC(2022, 4, 6)),
    ],
    more: false,
  },
]

const album = {
  id: 101,
  name: 'Album A',
  picUrl: 'https://img.example.test/album-101.jpg',
}

const createTrack = (
  id: number,
  name: string,
  no: number,
  qualities: Record<string, unknown>,
) => ({
  id,
  name,
  artists: id == 502
    ? [{ id: 3060, name: 'Fixture Artist' }, { id: 4000, name: 'Guest Artist' }]
    : [{ id: 3060, name: 'Fixture Artist' }],
  album,
  duration: 180000 + no * 1000,
  no,
  disc: '1',
  ...qualities,
})

export const wyAlbumDetailResponse = {
  code: 200,
  album: {
    ...album,
    size: 4,
    songs: [
      createTrack(501, 'Track 128', 1, {
        lMusic: { size: 3 * 1024 * 1024 },
        mMusic: { size: 4 * 1024 * 1024 },
      }),
      createTrack(502, 'Track 320', 2, {
        hMusic: { size: 8 * 1024 * 1024 },
      }),
      createTrack(503, 'Track FLAC', 3, {
        sqMusic: { size: 24 * 1024 * 1024 },
      }),
      createTrack(504, 'Track Hi-Res', 4, {
        hrMusic: { size: 48 * 1024 * 1024 },
      }),
    ],
  },
}

export const wyAlbumDetailZeroTrackNumberResponse = {
  code: 200,
  album: {
    ...album,
    size: 2,
    songs: [
      createTrack(705, 'Legacy Zero Track Number A', 0, {
        lMusic: { size: 3 * 1024 * 1024 },
      }),
      createTrack(706, 'Legacy Zero Track Number B', 0, {
        hMusic: { size: 8 * 1024 * 1024 },
      }),
    ],
  },
}

const modernAlbum = {
  id: 101,
  name: 'Album A',
  picUrl: 'https://img.example.test/album-101.jpg',
}

const createModernTrack = (
  id: number,
  name: string,
  no: number,
  qualities: Record<string, unknown>,
) => ({
  id,
  name,
  ar: id == 602
    ? [{ id: 3060, name: 'Fixture Artist' }, { id: 4000, name: 'Guest Artist' }]
    : [{ id: 3060, name: 'Fixture Artist' }],
  al: modernAlbum,
  dt: 200000 + no * 1000,
  no,
  cd: '01',
  ...qualities,
})

export const wyAlbumDetailV1Response = {
  code: 200,
  album: {
    ...modernAlbum,
    size: 4,
    songs: [],
  },
  songs: [
    createModernTrack(601, 'Modern Track 128', 1, {
      l: { size: 3 * 1024 * 1024 },
    }),
    createModernTrack(602, 'Modern Track 320', 2, {
      h: { size: 8 * 1024 * 1024 },
    }),
    createModernTrack(603, 'Modern Track FLAC', 3, {
      sq: { size: 24 * 1024 * 1024 },
    }),
    createModernTrack(604, 'Modern Track Hi-Res', 4, {
      hr: { size: 48 * 1024 * 1024 },
    }),
  ],
}

export const wyAlbumDetailV1ZeroTrackNumberResponse = {
  code: 200,
  album: {
    ...modernAlbum,
    size: 2,
    songs: [],
  },
  songs: [
    createModernTrack(701, 'Zero Track Number A', 0, {
      l: { size: 3 * 1024 * 1024 },
    }),
    createModernTrack(702, 'Zero Track Number B', 0, {
      h: { size: 8 * 1024 * 1024 },
    }),
  ],
}

export const wyVerificationRequiredResponse = {
  code: -462,
  data: {
    verifyType: 50,
    verifyId: 1000000,
    eventId: '[redacted]',
    sign: '[redacted]',
  },
  message: 'Verification required.',
}

export const wyProviderRefusedResponse = {
  code: -460,
  message: 'Provider refused the request.',
}
