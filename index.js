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
    throw new Error(JSON.stringify(response.data.errors[0].message));
  }
  return response;
}

// --- FEATURE 1: AUTOMATED CHANNEL CREATION ---
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const action = req.body.action;

  if (event === 'pull_request' && action === 'opened') {
    const pr = req.body.pull_request;
    const prNumber = pr.number;
    
    const prTitleFormatted = pr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const repoName = process.env.GITHUB_REPO.toLowerCase();
    const channelName = `${repoName}-${prNumber}-${prTitleFormatted}`;

    try {
      const guild = client.guilds.cache.first(); 
      if (!guild) return console.log("❌ Discord Guild not found");

      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Discussion for PR #${prNumber}: ${pr.html_url}`,
      });

      newChannel.send(`🚀 **New PR Raised:** #${prNumber}\n**Title:** ${pr.title}\n**Link:** ${pr.html_url}\n\nUse \`Description -> ...\` and \`Label -> ...\` here to sync with the board.`);
    } catch (err) {
      console.error("❌ Failed to create channel:", err);
    }
  }
  res.status(200).send('OK');
});

// --- FEATURE 2: BOARD SYNC LOGIC (BULLETPROOF EDITION) ---
client.on('messageCreate', async (message) => {
  if (message.author.bot || !/Labels?\s*->/i.test(message.content)) return;

  try {
    console.log("\n🚀 --- NEW ENGINE SYNC STARTED --- 🚀");

    let description = "";
    let labelInput = "";

    // Extract Label
    const labelMatch = message.content.match(/Labels?\s*->\s*(.+)/i);
    if (labelMatch) labelInput = labelMatch[1].trim().toLowerCase();

    // Extract Description
    const descMatch = message.content.match(/Description\s*->\s*([\s\S]*?)(?=Labels?\s*->)/i);
    if (descMatch) {
      description = descMatch[1].trim();
    } else {
      const parts = message.content.split(/Labels?\s*->/i);
      description = parts[0].trim();
    }

    const prMatch = message.channel.name.match(/-(\d+)-/);
    if (!prMatch) return message.reply("❌ Cannot identify PR number from channel name.");
    const prNumber = parseInt(prMatch[1]);

    // 1. EXECUTE REST API (Comments & Labels)
    const restBase = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/issues/${prNumber}`;
    const restHeaders = { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } };
    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);
    console.log(`✅ REST Sync Complete: Label '${labelInput}' applied.`);

    // 2. EXECUTE GRAPHQL API (Board Movement)
    const findItemQuery = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            projectItems(first: 10) { nodes { id project { id } } }
            closingIssuesReferences(first: 10) {
              nodes { projectItems(first: 10) { nodes { id project { id } } } }
            }
          }
        }
      }`;

    const itemData = await queryGitHub(findItemQuery, { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, pr: prNumber });
    const prData = itemData.data.data.repository.pullRequest;

    const targetProjectId = process.env.PROJECT_ID.trim();
    let itemIdsToMove = [];

    // Gather ALL cards linked to this PR (The PR itself + Linked Issues)
    if (prData.projectItems.nodes) {
      prData.projectItems.nodes.forEach(node => {
        if (node.project.id === targetProjectId) itemIdsToMove.push(node.id);
      });
    }
    if (prData.closingIssuesReferences.nodes) {
      prData.closingIssuesReferences.nodes.forEach(issue => {
        if (issue.projectItems.nodes) {
          issue.projectItems.nodes.forEach(node => {
            if (node.project.id === targetProjectId) itemIdsToMove.push(node.id);
          });
        }
      });
    }

    if (itemIdsToMove.length === 0) {
      return message.reply(`⚠️ **Partial Sync:** Comment and label added, but I could not find a visible card on the Master Engine board to move!`);
    }

    // Determine target column based on your exact rules
    let targetOptionId = "";
    if (labelInput.includes("bug") || labelInput.includes("improvement")) {
      targetOptionId = process.env.OPTION_ID_TODO.trim();
    } else if (labelInput.includes("weekday")) {
      targetOptionId = process.env.OPTION_ID_REVIEW_FOUNDER.trim();
    } else if (labelInput.includes("weekend")) {
      targetOptionId = process.env.OPTION_ID_DONE.trim();
    }

    if (!targetOptionId) {
      return message.reply(`⚠️ **Partial Sync:** Label '${labelInput}' added, but it doesn't match any movement rules (bug, weekday, weekend). Card stayed put.`);
    }

    // Move every single card found
    for (const itemId of itemIdsToMove) {
      const moveMutation = `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }`;

      await queryGitHub(moveMutation, {
        projectId: targetProjectId,
        itemId: itemId,
        fieldId: process.env.STATUS_FIELD_ID.trim(),
        optionId: targetOptionId
      });
    }

    message.reply(`✅ **Full Engine Sync Complete!**\n- Comment added\n- Label **${labelInput}** applied\n- ${itemIdsToMove.length} card(s) securely moved.`);

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply(`❌ **Sync failed at GraphQL layer:** ${error.message}`);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

app.get(['/', '/api'], (req, res) => {
  res.send('Zlice Engine & Webhook Listener Online');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening for Webhooks on Port ${PORT}...`));
