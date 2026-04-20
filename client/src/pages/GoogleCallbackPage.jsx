import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import API from '../api/axios';
import toast from 'react-hot-toast';

const GoogleCallbackPage = () => {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const exchangeCode = async () => {
      const searchParams = new URLSearchParams(location.search);
      const code = searchParams.get('code');

      if (!code) {
        toast.error('No authorization code received');
        navigate('/');
        return;
      }

      try {
        const { data } = await API.post('/parts/export/google/token', { code });
        // Save access token temporarily (or in localStorage)
        localStorage.setItem('google_access_token', data.access_token);
        toast.success('Google account connected!');
        navigate('/');
      } catch (err) {
        toast.error('Failed to connect Google account');
        navigate('/');
      }
    };

    exchangeCode();
  }, [location, navigate]);

  return (
    <div style={{ 
      height: '100vh', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)'
    }}>
      <div style={{ textAlign: 'center' }}>
        <div className="skeleton-pulse" style={{ 
          width: '40px', 
          height: '40px', 
          borderRadius: '50%', 
          background: 'var(--accent)',
          margin: '0 auto 16px'
        }} />
        <p>Connecting your Google account...</p>
      </div>
    </div>
  );
};

export default GoogleCallbackPage;
