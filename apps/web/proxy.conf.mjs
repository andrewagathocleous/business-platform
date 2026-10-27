const target = process.env.WEB_API_ORIGIN || 'http://localhost:3000';

export default {
  '/api': {
    target,
    secure: false,
    changeOrigin: true,
  },
};
