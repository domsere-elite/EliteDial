import type { Metadata } from 'next';
import './globals.css';
import { ErrorBoundaryWrapper } from './ErrorBoundaryWrapper';

export const metadata: Metadata = {
    title: 'EliteDial — Collections Dialer',
    description: 'Standalone telephony platform for debt collections agencies',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                <ErrorBoundaryWrapper>{children}</ErrorBoundaryWrapper>
            </body>
        </html>
    );
}
