/** @type {import('next').NextConfig} */
const apiHost = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:5000';

const nextConfig = {
    async rewrites() {
        return [
            {
                source: '/api/:path*',
                destination: `${apiHost}/api/:path*`,
            },
        ];
    },
};

module.exports = nextConfig;
