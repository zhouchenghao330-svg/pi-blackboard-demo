import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const recipient = "zhouchenghao330@gmail.com";
const send = process.argv.includes("--send");
if (process.argv.slice(2).some((arg) => arg !== "--send")) {
  console.error("用法：node scripts/test-smtp.mjs [--send]");
  process.exit(2);
}

loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));

const { MEETING_SMTP_HOST: host, MEETING_SMTP_PORT: rawPort,
  MEETING_SMTP_USER: user, MEETING_SMTP_PASS: pass,
  MEETING_SMTP_FROM: from } = process.env;
const port = Number(rawPort || 587);
if (!host || !user || !pass || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(".env 中的 MEETING_SMTP_HOST/PORT/USER/PASS/FROM 配置不完整");
  process.exit(2);
}

const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
});

try {
  await transport.verify();
  console.log("SMTP 连接和登录验证通过。");
  if (send) {
    const sentAt = new Date().toISOString();
    const result = await transport.sendMail({
      from,
      to: recipient,
      subject: `Demo SMTP 测试 ${sentAt}`,
      text: `这是一封由本地 Demo SMTP 测试脚本发送的邮件。\n测试时间：${sentAt}\n`,
    });
    if (!result.accepted?.some((address) => address.toLowerCase() === recipient)) {
      throw new Error("SMTP 服务器未接受测试收件人");
    }
    console.log(`SMTP 服务器已接受发往 ${recipient} 的测试邮件。`);
    console.log("请检查收件箱和垃圾邮件箱，确认实际收到。");
  } else {
    console.log("本次没有发送邮件；加 --send 可发一封测试邮件。");
  }
} catch (error) {
  const message = String(error.message || error).replaceAll(pass, "[redacted]");
  console.error(`SMTP 测试失败：${message}`);
  process.exitCode = 1;
} finally {
  transport.close();
}
