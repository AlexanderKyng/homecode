const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://homecode.ai" : `https://${stage}.homecode.ai`,
  console: stage === "production" ? "https://homecode.ai/auth" : `https://${stage}.homecode.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/homecode",
  discord: "https://homecode.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
