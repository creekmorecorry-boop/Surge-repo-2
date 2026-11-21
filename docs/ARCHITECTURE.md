# FEEDSURGE rebuild architecture

## Intended request flow
Frontend UI → frontend service layer → authenticated API → backend validation and authorization → database/storage → response → synchronized UI state.

## Product areas to implement
- Arena: continuous vertical discovery feed; independently swipeable horizontal rails; photos and video posts; creator recommendations.
- Flick: immersive video viewer opened at the exact tapped Arena video; vertical next/previous navigation; real engagement actions.
- Photo viewer: full-screen photo view and ordered horizontal swipe for multi-photo posts.
- Stories: separate publishing and viewing area. A story must never also create an Arena post.
- Center plus: ordinary posts publish to Arena and the creator profile.
- Profiles, follows, search, Board, Activity, DMs, notifications, settings, reporting, blocking, moderation and admin tools.
- Creator tools and monetization only after billing requirements and safety checks are reviewed.

## State and navigation
Returning from Flick, photo viewer or profile must restore the previous Arena scroll position and horizontal rail position. Arena and Flick must use the same underlying post, creator and engagement records.
