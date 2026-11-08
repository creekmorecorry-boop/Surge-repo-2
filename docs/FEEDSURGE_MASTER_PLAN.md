# FEEDSURGE — Master Product & Development Plan

## 1. Mission

FEEDSURGE is a social platform and creator-growth ecosystem designed to help people discover content, build communities, grow audiences, connect with opportunities, and develop businesses.

The product combines social networking, short-form video, creator tools, business capabilities, promotion, and meaningful engagement into one connected platform.

Build a high-quality, mobile-first product that delivers genuine value. Do not make unsupported promises about guaranteed growth, reach, or earnings.

## 2. Product Principles

- Preserve and improve the existing SURGE Passionate/Kinetic foundation.
- Do not revert to the old Arcade design.
- Use FEEDSURGE as the current working brand.
- Preserve working features and existing data.
- Do not replace functional systems with static demonstrations.
- Do not invent posts, members, engagement, analytics, or earnings.
- Keep ordinary social participation genuinely useful on the Free tier.
- Make paid features optional upgrades for advanced creator and business needs.
- Clearly distinguish organic recommendations from paid placements.
- Protect user privacy, account security, and content ownership.
- Build mobile-first, including iPhone safe-area support.
- Verify functionality before calling a feature complete.

## 3. Product Experience

### Social Network
- Personalized home feed
- Short-form vertical video
- Photo and video posts
- Stories
- Creator and member profiles
- Follow and unfollow
- Likes, comments, reposts, saves, and sharing
- Search and content discovery
- Notifications
- Direct messages
- Communities and group conversations
- Live experiences and event discovery

### Creator Growth
- Creator Studio
- Audience and content analytics
- Content performance history
- Growth goals and progress
- Audience discovery
- Collaboration discovery
- Content planning tools
- Promotion controls
- Transparent campaign performance
- Creator portfolio and professional profile

### Creator Economy
- Creator and brand opportunity discovery
- Collaboration requests
- Campaign briefs
- Partnership communication
- Creator services and digital products
- Ticketed experiences and events
- Transaction history and reporting
- Clear disclosure of paid partnerships

### Business Suite
- Business profiles
- Team access and roles
- Campaign creation and management
- Sponsored placements
- Audience insights
- Lead and conversion tracking
- Spending controls
- Campaign reporting
- Business performance tools

### Kinetic System
- Points and achievements
- Missions and participation challenges
- Meaningful rewards
- Transparent eligibility and claim limits
- Anti-spam and anti-manipulation protections

### Safety and Trust
- Report content and accounts
- Block and restrict accounts
- Privacy controls
- Content moderation
- Account security
- Copyright and intellectual-property reporting
- Administrative review tools
- Abuse and fraud prevention

## 4. Membership Strategy

The Free tier must support normal social participation without requiring payment.

Paid memberships may provide advanced creator intelligence, expanded professional tools, business capabilities, and additional campaign features.

Membership names, prices, limits, billing intervals, and entitlements are NOT finalized in this document.

Do not restore old Square checkout or old SURGE membership pricing without explicit approval. Keep the future billing architecture provider-independent until a provider and commercial model are selected.

## 5. Development Phases

### Phase 1 — Product Experience
Audit the existing application and complete the user-facing experience.

Priorities:
- Home feed and navigation
- Profiles and creator pages
- Stories and short-form video
- Discover and search
- Messaging and communities
- Creator Studio and growth tools
- Kinetic
- Campaigns and opportunities
- Business Suite
- Ads and revenue tools
- Safety, privacy, and moderation

Preserve existing working features and the current Passionate visual foundation.

### Phase 2 — Backend Connections
Connect the interface to real services and persistent data.

Priorities:
- Authentication and account recovery
- User profiles and settings
- Database operations
- Photo and video uploads
- Feed and content delivery
- Likes, comments, follows, reposts, and saves
- Stories and video
- Messaging and notifications
- Communities
- Kinetic points and missions
- Campaigns and business functionality
- Analytics based on actual events
- Reporting and moderation

### Phase 3 — Integration and Testing
Test complete user journeys, not just individual screens.

Verify:
- Registration, login, logout, and password recovery
- Profile creation and editing
- Uploading and publishing media
- Feed loading and content interactions
- Following and discovery
- Messaging and notifications
- Communities
- Kinetic activity
- Campaign workflows
- Business tools
- Privacy and moderation
- Mobile navigation and responsive layouts

Fix broken connections, errors, security issues, and incomplete workflows.

### Phase 4 — Launch Readiness
- Finalize FEEDSURGE branding
- Polish mobile and desktop experiences
- Improve performance and accessibility
- Verify security and privacy controls
- Verify database and backend health
- Test production configuration
- Verify deployment and domain
- Complete final launch testing

## 6. Technical Architecture

Existing infrastructure must be audited before changes are made.

Known project components:
- GitHub repository: creekmorecorry-boop/Surge-repo-2
- Development branch: feedsurge-development
- Existing frontend: index.html
- Existing backend code: backend/server.js and root server.js
- Existing authentication helper: surge-auth.js
- Existing database migration: backend/migration.sql
- Existing backend service: Render
- Existing database/authentication: Supabase
- Existing media storage: Cloudflare R2

Important: Determine which backend entrypoint is actually deployed before changing backend behavior. Do not assume the root server and backend/server.js are interchangeable.

Keep credentials and secrets out of frontend code and GitHub. Use server-side authorization, validation, and secure storage.

Use database migrations for schema changes. Preserve existing user data.

## 7. Revenue and Business Integrity

Potential revenue sources:
- Optional creator memberships
- Optional business memberships
- Paid promotional campaigns
- Sponsored placements
- Creator and brand marketplace transactions
- Creator services and digital products
- Ticketed events and experiences

Do not activate payment collection until pricing, entitlements, provider, transaction verification, refunds, and customer support requirements are defined and tested.

Sponsored content must be clearly labeled. Organic ranking must not secretly become pay-to-win.

## 8. Development Rules

1. Audit before modifying.
2. Preserve working functionality.
3. Work on feedsurge-development, not main.
4. Make focused, reviewable changes.
5. Avoid unnecessary rewrites of the large existing index.html.
6. Never expose secrets or private credentials.
7. Do not fabricate functionality or analytics.
8. Test every important user workflow.
9. Document completed work and remaining issues.
10. Do not deploy unverified changes to production.

## 9. Completion Standard

A feature is complete only when:
- Its interface works on mobile and desktop.
- Its backend connection works where required.
- Data persists correctly.
- Authentication and permissions are enforced.
- Errors and empty states are handled.
- It has been tested through a real user workflow.
- It does not break existing functionality.

## 10. Project Checkpoint

This document is the guiding product and development plan for FEEDSURGE.

It does not replace the existing application or authorize deleting existing files, data, or features.

The goal is to evolve the existing Passionate/Kinetic foundation into a complete, reliable, valuable social and creator platform through controlled development phases.
