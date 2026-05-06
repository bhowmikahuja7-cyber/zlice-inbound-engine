const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const express = require('express');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.GITHUB_REPO;

// Helper for GitHub GraphQL calls
async function queryGitHub(query, variables) {
  return axios.post('https://api.github.com/graphql', { query, variables }, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
  });
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.includes('Labels ->')) return;

  try {
    const lines = message.content.split('\n').map(l => l.trim()).filter(l => l !== "");
    const labelsIndex = lines.findIndex(l => l.includes('Labels ->'));
    const description = lines.slice(1, labelsIndex).join('\n');
    const labelInput = lines[labelsIndex].split('->')[1].trim().toLowerCase();

    const prMatch = message.channel.name.match(/^\d+/);
    if (!prMatch) return message.reply("❌ No PR number in channel name.");
    const prNumber = parseInt(prMatch[0]);

    // 1. Post Comment and Apply Label (REST API)
    const restBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues/${prNumber}`;
    const restHeaders = { headers: { Authorization: `token ${GITHUB_TOKEN}` } };

    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);

    // 2. Move Project Board Card (GraphQL API)
    // First, find the Item ID on the Project Board
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

    const itemData = await queryGitHub(findItemQuery, { owner: REPO_OWNER, repo: REPO_NAME, pr: prNumber });
    const projectItem = itemData.data.data.repository.pullRequest.projectItems.nodes[0];

    if (projectItem) {
      // Map labels to your Column Option IDs (You will set these in Replit Secrets)
      let targetOptionId = "";
      if (labelInput.includes("bug")) targetOptionId = process.env.OPTION_ID_TODO;
      if (labelInput.includes("weekday")) targetOptionId = process.env.OPTION_ID_REVIEW;
      if (labelInput.includes("weekend")) targetOptionId = process.env.OPTION_ID_DONE;

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

        await queryGitHub(moveMutation, {
          projectId: projectItem.project.id,
          itemId: projectItem.id,
          fieldId: process.env.STATUS_FIELD_ID,
          optionId: targetOptionId
        });
      }
    }

    message.reply(`✅ **Engine Sync Complete**\n- Comment added\n- Label **${labelInput}** applied\n- Board card moved.`);

  } catch (error) {
    console.error(error);
    message.reply("❌ Sync failed. Check Replit logs.");
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
const app = express();
app.get('/', (req, res) => res.send('Zlice Engine Online'));
app.listen(8080);