import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Landing from './pages/Landing.js';
import Room from './pages/Room.js';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Landing />,
    errorElement: (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'var(--font-ui)',
          color: 'var(--ink)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h1>Oops!</h1>
          <p>Something went wrong. Please try refreshing the page.</p>
        </div>
      </div>
    ),
  },
  {
    path: '/rooms/:id',
    element: <Room />,
  },
]);

export default function AppRouter() {
  return <RouterProvider router={router} />;
}
