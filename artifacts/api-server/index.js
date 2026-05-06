const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const express = require('express');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

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

    // 1. REST API
    const restBase = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/issues/${prNumber}`;
    const restHeaders = { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } };
    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);

    // 2. GraphQL API
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
      console.log(`🎯 Found PR on Board: "${projectItem.project.title}"`);

      let targetOptionId = "";
      if (labelInput.includes("done review (weekday)")) targetOptionId = process.env.OPTION_ID_REVIEW_FOUNDER;
      else if (labelInput.includes("bug")) targetOptionId = process.env.OPTION_ID_TODO;
      else if (labelInput.includes("weekday")) targetOptionId = process.env.OPTION_ID_REVIEW;
      else if (labelInput.includes("weekend")) targetOptionId = process.env.OPTION_ID_DONE;

      console.log(`🔑 Target Column ID to send: ${targetOptionId}`);

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

        const mutationResult = await queryGitHub(moveMutation, {
          projectId: projectItem.project.id,
          itemId: projectItem.id,
          fieldId: process.env.STATUS_FIELD_ID,
          optionId: targetOptionId
        });

        console.log("✅ GitHub Mutation Response:", JSON.stringify(mutationResult.data.data, null, 2));
      } else {
         console.log("⚠️ No Target Option ID matched!");
      }
    } else {
      console.log("❌ Could not find this PR attached to any Project Board!");
    }

    console.log("🏁 --- SYNC FINISHED ---\n");
    message.reply(`✅ **Engine Sync Complete**\n- Comment added\n- Label **${labelInput}** applied\n- Board card moved.`);

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply("❌ Sync failed. Check Replit logs.");
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
const app = express();
app.get('/', (req, res) => res.send('Zlice Engine Online'));
app.listen(8080);