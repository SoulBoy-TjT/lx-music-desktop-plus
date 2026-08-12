export const txArtistSearchResponse = {
  code: 0,
  data: {
    singer: {
      list: [
        {
          singerMID: 'fixture-artist-mid',
          singerName: 'Fixture Artist',
          singerPic: 'https://img.example.test/artist.jpg',
          albumNum: 3,
        },
        {
          singerMID: 'fuzzy-artist-mid',
          singerName: 'The Fixture Artist Band',
          singerPic: 'https://img.example.test/fuzzy.jpg',
          albumNum: 1,
        },
      ],
    },
  },
}

export const txFuzzyArtistSearchResponse = {
  code: 0,
  data: {
    singer: {
      list: [
        {
          singerMID: 'fuzzy-artist-mid',
          singerName: 'The Fixture Artist Band',
          singerPic: 'https://img.example.test/fuzzy.jpg',
          albumNum: 1,
        },
      ],
    },
  },
}

const album = (
  albumMid: string,
  albumName: string,
  totalNum: number,
  publishDate: string,
) => ({
  albumMid,
  albumID: Number(albumMid.replace(/\D/g, '')),
  albumName,
  publishDate,
  totalNum,
  singerName: 'Fixture Artist',
})

export const txAlbumPageResponses = [
  {
    code: 0,
    req: {
      code: 0,
      data: {
        total: 3,
        albumList: [
          album('fixture-album-mid-1', 'Fixture Album One', 3, '2024-02-29'),
          album('fixture-album-mid-2', 'Fixture Album Two', 1, '2023-05-06'),
        ],
      },
    },
  },
  {
    code: 0,
    req: {
      code: 0,
      data: {
        total: 3,
        albumList: [
          album('fixture-album-mid-3', 'Fixture Album Three', 2, '2022-03-04'),
        ],
      },
    },
  },
]

const track = (
  songMid: string,
  title: string,
  trackNumber: number,
  albumMid = 'fixture-album-mid-1',
) => ({
  songInfo: {
    id: 1000 + trackNumber,
    mid: songMid,
    title,
    interval: 180 + trackNumber,
    index_album: trackNumber,
    singer: [
      { mid: 'fixture-artist-mid', name: 'Fixture Artist' },
    ],
    album: {
      id: 9001,
      mid: albumMid,
      name: 'Fixture Album One',
    },
    file: {
      media_mid: `media-${songMid}`,
      size_128mp3: 1024,
      size_320mp3: trackNumber == 1 ? 2048 : 0,
      size_flac: 0,
      size_hires: 0,
    },
  },
})

export const txAlbumTrackPageResponses = [
  {
    code: 0,
    req: {
      code: 0,
      data: {
        totalNum: 3,
        songList: [
          track('fixture-song-mid-1', 'Fixture Track One', 1),
          track('fixture-song-mid-2', 'Fixture Track Two', 2),
        ],
      },
    },
  },
  {
    code: 0,
    req: {
      code: 0,
      data: {
        totalNum: 3,
        songList: [
          track('fixture-song-mid-3', 'Fixture Track Three', 3),
        ],
      },
    },
  },
]

export const txWrongAlbumTrackResponse = {
  code: 0,
  req: {
    code: 0,
    data: {
      totalNum: 1,
      songList: [
        track('wrong-album-song-mid', 'Wrong Album Track', 1, 'different-album-mid'),
      ],
    },
  },
}
