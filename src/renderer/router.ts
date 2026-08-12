/* eslint-disable @typescript-eslint/no-var-requires */
// import Vue from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'


const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/search',
      name: 'Search',
      component: require('./views/Search/index.vue').default,
      meta: {
        name: 'Search',
      },
    },
    {
      path: '/songList/list',
      name: 'SongList',
      component: require('./views/songList/List/index.vue').default,
      meta: {
        name: 'SongList',
      },
    },
    {
      path: '/songList/detail',
      name: 'SongListDetail',
      component: require('./views/songList/Detail/index.vue').default,
      meta: {
        name: 'SongList',
      },
    },
    {
      path: '/leaderboard',
      name: 'Leaderboard',
      component: require('./views/Leaderboard/index.vue').default,
      meta: {
        name: 'Leaderboard',
      },
    },
    {
      path: '/list',
      name: 'List',
      component: require('./views/List/index.vue').default,
      meta: {
        name: 'List',
      },
    },
    {
      path: '/download',
      name: 'Download',
      component: require('./views/Download/index.vue').default,
      meta: {
        name: 'Download',
      },
    },
    {
      path: '/album-collection',
      name: 'AlbumCollection',
      component: require('./views/Tools/index.vue').default,
      meta: {
        name: 'AlbumCollection',
        keepAlive: true,
      },
    },
    {
      path: '/tools',
      redirect: '/album-collection',
    },
    {
      path: '/song-organizer',
      name: 'SongOrganizer',
      component: require('./views/SongOrganizer/index.vue').default,
      meta: {
        name: 'SongOrganizer',
        keepAlive: true,
      },
    },
    {
      path: '/flac-converter',
      name: 'FlacConverter',
      component: require('./views/FlacConverter/index.vue').default,
      meta: {
        name: 'FlacConverter',
        keepAlive: true,
      },
    },
    {
      path: '/setting',
      name: 'Setting',
      component: require('./views/Setting/index.vue').default,
      meta: {
        name: 'Setting',
      },
    },
    { path: '/:pathMatch(.*)*', redirect: '/search' },
  ],
  linkActiveClass: 'active-link',
  linkExactActiveClass: 'exact-active-link',
})


export default router
