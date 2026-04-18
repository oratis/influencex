/**
 * Standalone demo-data seeder.
 *
 * Run:  node server/seed-demo.js
 *
 * Creates:
 *   - A demo admin user (demo@influencex.dev / demo1234)
 *   - Two sample campaigns (Gaming Q2 + AI Tools Launch)
 *   - 12 KOLs across YouTube / TikTok / Instagram with realistic stats
 *   - Draft outreach emails using the built-in template system
 *
 * Safe to run multiple times — skips records that already exist by checking
 * unique keys. Uses the same DB connection as the live server.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, exec, initializeDatabase } = require('./database');
const { registerUser } = require('./auth');
const { renderEmail } = require('./email-templates');

const SAMPLE_KOLS = [
  { platform: 'youtube', username: 'RetroGameVault', display_name: 'Retro Game Vault', followers: 245_000, engagement_rate: 4.2, avg_views: 85_000, category: 'Gaming', email: 'booking@retrogamevault.example' },
  { platform: 'youtube', username: 'AIArtToday', display_name: 'AI Art Today', followers: 182_000, engagement_rate: 3.8, avg_views: 62_000, category: 'AI', email: 'hello@aiarttoday.example' },
  { platform: 'youtube', username: 'ProPlaysHQ', display_name: 'Pro Plays HQ', followers: 510_000, engagement_rate: 5.1, avg_views: 145_000, category: 'Gaming', email: null },
  { platform: 'tiktok', username: 'miniclips.gg', display_name: 'MiniClips Gaming', followers: 98_000, engagement_rate: 6.8, avg_views: 55_000, category: 'Gaming', email: 'partners@miniclips.example' },
  { platform: 'tiktok', username: 'ai.prompts.daily', display_name: 'AI Prompts Daily', followers: 134_000, engagement_rate: 7.2, avg_views: 72_000, category: 'AI', email: null },
  { platform: 'tiktok', username: 'speedruntok', display_name: 'SpeedrunTok', followers: 67_000, engagement_rate: 5.9, avg_views: 38_000, category: 'Gaming', email: 'hi@speedruntok.example' },
  { platform: 'instagram', username: 'cozygamerlife', display_name: 'Cozy Gamer Life', followers: 156_000, engagement_rate: 4.7, avg_views: 48_000, category: 'Gaming', email: 'cozygamer@mail.example' },
  { platform: 'instagram', username: 'neural.studio', display_name: 'Neural Studio', followers: 92_000, engagement_rate: 3.4, avg_views: 28_000, category: 'AI', email: 'contact@neuralstudio.example' },
  { platform: 'youtube', username: 'IndieDevDiary', display_name: 'Indie Dev Diary', followers: 78_000, engagement_rate: 4.9, avg_views: 32_000, category: 'Gaming', email: 'indie@devdiary.example' },
  { platform: 'youtube', username: 'PromptEngineer', display_name: 'Prompt Engineer', followers: 215_000, engagement_rate: 5.5, avg_views: 92_000, category: 'AI', email: null },
  { platform: 'tiktok', username: 'rpgmoments', display_name: 'RPG Moments', followers: 45_000, engagement_rate: 7.8, avg_views: 29_000, category: 'Gaming', email: 'rpg@moments.example' },
  { platform: 'instagram', username: 'ai.character.art', display_name: 'AI Character Art', followers: 71_000, engagement_rate: 4.1, avg_views: 22_000, category: 'AI', email: 'art@aichar.example' },
];

async function seedAdmin() {
  const email = 'demo@influencex.dev';
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    console.log(`• admin ${email} already exists`);
    return existing.id;
  }
  const user = await registerUser(email, 'demo1234', 'Demo Admin');
  if (user.error) throw new Error(user.error);
  await exec('UPDATE users SET role=? WHERE id=?', ['admin', user.id]);
  console.log(`• created admin ${email} / demo1234`);
  return user.id;
}

async function seedCampaigns() {
  const campaigns = [
    {
      id: uuidv4(),
      name: 'Gaming Q2 Push',
      description: 'Spring campaign targeting gaming and esports creators for our new title',
      platforms: JSON.stringify(['youtube', 'tiktok', 'instagram']),
      daily_target: 10,
      budget: 25_000,
      filter_criteria: JSON.stringify({ min_followers: 50_000, min_engagement: 3, categories: 'Gaming' }),
      status: 'active',
    },
    {
      id: uuidv4(),
      name: 'AI Tools Launch',
      description: 'Outreach for our AI-generated content platform — target AI/ML content creators',
      platforms: JSON.stringify(['youtube', 'tiktok', 'instagram']),
      daily_target: 5,
      budget: 15_000,
      filter_criteria: JSON.stringify({ min_followers: 30_000, min_engagement: 2.5, categories: 'AI' }),
      status: 'active',
    },
  ];

  const created = [];
  for (const c of campaigns) {
    const existing = await queryOne('SELECT id FROM campaigns WHERE name = ?', [c.name]);
    if (existing) {
      console.log(`• campaign "${c.name}" already exists`);
      created.push({ ...c, id: existing.id });
      continue;
    }
    await exec(
      'INSERT INTO campaigns (id, name, description, platforms, daily_target, budget, filter_criteria, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [c.id, c.name, c.description, c.platforms, c.daily_target, c.budget, c.filter_criteria, c.status]
    );
    created.push(c);
    console.log(`• created campaign "${c.name}"`);
  }
  return created;
}

async function seedKols(campaigns) {
  const gameCampaign = campaigns.find(c => /Gaming/.test(c.name));
  const aiCampaign = campaigns.find(c => /AI/.test(c.name));

  for (const k of SAMPLE_KOLS) {
    const targetCampaign = k.category === 'Gaming' ? gameCampaign : aiCampaign;
    if (!targetCampaign) continue;

    const existing = await queryOne(
      'SELECT id FROM kols WHERE campaign_id = ? AND platform = ? AND username = ?',
      [targetCampaign.id, k.platform, k.username]
    );
    if (existing) continue;

    const aiScore = Math.min(99, Math.floor(
      (k.engagement_rate * 5) +
      (Math.min(k.followers, 500_000) / 10_000) +
      (Math.min(k.avg_views, 150_000) / 5_000)
    ));

    await exec(
      'INSERT INTO kols (id, campaign_id, platform, username, display_name, followers, engagement_rate, avg_views, category, email, profile_url, ai_score, ai_reason, estimated_cpm, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uuidv4(), targetCampaign.id, k.platform, k.username, k.display_name,
        k.followers, k.engagement_rate, k.avg_views, k.category, k.email,
        `https://${k.platform}.com/@${k.username}`,
        aiScore,
        `${k.category} focus, ${k.engagement_rate}% engagement, ${(k.followers / 1000).toFixed(0)}K followers`,
        +(12 + k.engagement_rate * 1.5).toFixed(2),
        'approved',
      ]
    );
  }
  console.log(`• seeded ${SAMPLE_KOLS.length} KOLs across 2 campaigns`);
}

async function seedDraftContacts(campaigns) {
  // Create draft contacts only for KOLs with an email
  const kols = await query('SELECT * FROM kols WHERE email IS NOT NULL');
  let created = 0;
  for (const kol of kols.rows || []) {
    const existing = await queryOne('SELECT id FROM contacts WHERE kol_id = ?', [kol.id]);
    if (existing) continue;

    const rendered = renderEmail('outreach-affiliate-en', {
      kol_name: kol.display_name || kol.username,
      platform: kol.platform,
      followers: kol.followers > 1000 ? (kol.followers / 1000).toFixed(1) + 'K' : String(kol.followers),
      category: kol.category,
      sender_name: 'Demo Admin',
      product_name: 'InfluenceX',
    });

    await exec(
      'INSERT INTO contacts (id, kol_id, campaign_id, email_subject, email_body, cooperation_type, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), kol.id, kol.campaign_id, rendered.subject, rendered.body, 'affiliate', 'draft']
    );
    created += 1;
  }
  console.log(`• drafted ${created} outreach emails`);
}

async function main() {
  console.log('Seeding InfluenceX demo data...');
  await initializeDatabase();
  await seedAdmin();
  const campaigns = await seedCampaigns();
  await seedKols(campaigns);
  await seedDraftContacts(campaigns);
  console.log('\nDone. Log in at /InfluenceX with demo@influencex.dev / demo1234');
  process.exit(0);
}

main().catch(e => {
  console.error('Seed failed:', e);
  process.exit(1);
});
