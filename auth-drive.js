require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');
const fs = require('fs');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

const url = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive.file'],
  prompt: 'consent',
});

console.log('\nOpen this URL in your browser:\n\n' + url + '\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    if (!tokens.refresh_token) {
      console.log('ERROR: No refresh token received. Try revoking access at https://myaccount.google.com/permissions and running again.');
      return;
    }
    let envContent = fs.readFileSync('.env', 'utf8');
    if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/GOOGLE_REFRESH_TOKEN=.*/, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      envContent += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
    }
    fs.writeFileSync('.env', envContent);
    console.log('\nDone! Refresh token saved to .env');
  } catch (err) {
    console.error('Error:', err.message);
  }
});
