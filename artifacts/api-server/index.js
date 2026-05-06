const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const app = express();
app.use(bodyParser.json());

// --- HELPER: GITHUB GRAPHQL ---
async function queryGitHub(query, variables) {
  const response = await axios.post('https://api.github.com/graphql', { query, variables }, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  });
  if (response.data.errors) {
    console.error("🚨 GRAPHQL ERROR:", JSON.stringify(response.data.errors, null, 2));
    throw new Error("GitHub rejected the GraphQL request.");
  }
  return response;
}

// --- FEATURE 1: AUTOMATED CHANNEL CREATION (Incoming from GitHub) ---
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const action = req.body.action;

  if (event === 'pull_request' && action === 'opened') {
    const pr = req.body.pull_request;
    const prNumber = pr.number;
    const prTitle = pr.title.toLowerCase().replace(/\s+/g, '-');
    const channelName = `${prNumber}-${prTitle}`;

    try {
      const guild = client.guilds.cache.first(); 
      if (!guild) return console.log("❌ Discord Guild not found");

      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Discussion for PR #${prNumber}: ${pr.html_url}`,
      });

      console.log(`🚀 Automated Channel Created: #${channelName}`);
      newChannel.send(`🚀 **New PR Raised:** #${prNumber}\n**Title:** ${pr.title}\n**Link:** ${pr.html_url}\n\nUse \`Labels -> ...\` here to sync with the board.`);
    } catch (err) {
      console.error("❌ Failed to create channel:", err);
    }
  }
  res.status(200).send('OK');
});

// --- FEATURE 2: BOARD SYNC LOGIC (Triggered from Discord) ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.includes('Labels ->')) return;

  try {
    console.log("\n🚀 --- NEW ENGINE SYNC STARTED --- 🚀");
    const lines = message.content.split('\n').map(l => l.trim()).filter(l => l !== "");
    const labelsIndex = lines.findIndex(l => l.includes('Labels ->'));
    const description = lines.slice(1, labelsIndex).join('\n');
    const labelInput = lines[labelsIndex].split('->')[1].trim().toLowerCase();

    const prMatch = message.channel.name.match(/^\d+/);
    if (!prMatch) return message.reply("❌ No PR number in channel name.");
    const prNumber = parseInt(prMatch[0]);

    console.log(`📌 PR Number: ${prNumber} | Label Detected: "${labelInput}"`);

    // 1. REST API: Comments & Labels
    const restBase = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/issues/${prNumber}`;
    const restHeaders = { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } };
    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);

    // 2. GraphQL API: Board Movement
    const findItemQuery = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            projectItems(first: 5) {
              nodes {
                id
                project { id title }
              }
            }
          }
        }
      }`;

    const itemData = await queryGitHub(findItemQuery, { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, pr: prNumber });
    const nodes = itemData.data.data.repository.pullRequest.projectItems.nodes;

    if (nodes && nodes.length > 0) {
      const projectItem = nodes[0];
      let targetOptionId = "";

      if (labelInput.includes("done review (weekday)")) targetOptionId = process.env.OPTION_ID_REVIEW_FOUNDER;
      else if (labelInput.includes("bug")) targetOptionId = process.env.OPTION_ID_TODO;
      else if (labelInput.includes("weekday")) targetOptionId = process.env.OPTION_ID_REVIEW;
      else if (labelInput.includes("weekend")) targetOptionId = process.env.OPTION_ID_DONE;

      if (targetOptionId) {
        const moveMutation = `
          mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId,
              itemId: $itemId,
              fieldId: $fieldId,
              value: { singleSelectOptionId: $optionId }
            }) { projectV2Item { id } }
          }`;

        const result = await queryGitHub(moveMutation, {
          projectId: projectItem.project.id,
          itemId: projectItem.id,
          fieldId: process.env.STATUS_FIELD_ID,
          optionId: targetOptionId
        });
        console.log("✅ GitHub Mutation Response:", JSON.stringify(result.data.data, null, 2));
      }
    } else {
      console.log("❌ Could not find this PR attached to any Project Board!");
    }

    message.reply(`✅ **Engine Sync Complete**\n- Comment added\n- Label **${labelInput}** applied\n- Board card moved.`);
    console.log("🏁 --- SYNC FINISHED ---\n");

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply("❌ Sync failed. Check Replit logs.");
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
app.get('/', (req, res) => res.send('Zlice Engine & Webhook Listener Online'));
app.listen(3000, () => console.log('Listening for Webhooks on Port 3000...'));