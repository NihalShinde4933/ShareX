
import React, { ReactNode } from 'react'
import "./globals.css"; // Ensure the path accurately points to your file



function Layout({ children }: { children: React.ReactNode }) {
    return (
        <html>
            <body>
                {children}
            </body>
        </html>
    )
}

export default Layout
