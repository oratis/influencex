/**
 * Mail Agent - handles email sending via Resend API
 * Also supports legacy SMTP via nodemailer as fallback
 */

function isConfigured() {
  return !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));
}

function getProvider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return null;
}

async function sendEmail({ to, subject, body, fromName }) {
  const provider = getProvider();
  if (!provider) {
    return { success: false, error: 'Email not configured. Set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS.' };
  }

  if (provider === 'resend') {
    return sendViaResend({ to, subject, body, fromName });
  }
  return sendViaSMTP({ to, subject, body, fromName });
}

async function sendViaResend({ to, subject, body, fromName }) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'contact@market.hakko.ai';
  const replyTo = process.env.RESEND_REPLY_TO || 'market@hakko.ai';
  const from = `${fromName || 'HakkoAI Team'} <${fromEmail}>`;

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: Array.isArray(to) ? to : [to],
      reply_to: replyTo,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });

    if (error) {
      return { success: false, error: error.message || JSON.stringify(error) };
    }

    return {
      success: true,
      messageId: data?.id,
      provider: 'resend',
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function sendViaSMTP({ to, subject, body, fromName }) {
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: (process.env.SMTP_PORT || '587') === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const from = `${fromName || process.env.SMTP_FROM_NAME || 'HakkoAI Team'} <${process.env.SMTP_USER}>`;

  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });

    return {
      success: true,
      messageId: info.messageId,
      accepted: info.accepted,
      provider: 'smtp',
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function verifyConnection() {
  const provider = getProvider();
  if (!provider) return { configured: false };

  if (provider === 'resend') {
    // Resend doesn't have a verify method, just check the key exists
    return { configured: true, verified: true, provider: 'resend' };
  }

  // SMTP verify
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: (process.env.SMTP_PORT || '587') === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.verify();
    return { configured: true, verified: true, provider: 'smtp' };
  } catch (e) {
    return { configured: true, verified: false, error: e.message, provider: 'smtp' };
  }
}

module.exports = { isConfigured, sendEmail, verifyConnection, getProvider };
