import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import API from '../api/axios';
import Navbar from '../components/Navbar';
import SearchBar from '../components/SearchBar';
import PartTable from '../components/PartTable';
import AddPartModal from '../components/AddPartModal';
import EditPartModal from '../components/EditPartModal';
import DeletePartModal from '../components/DeletePartModal';
import ImageModal from '../components/ImageModal';
import DownloadProgressModal from '../components/DownloadProgressModal';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlineDownload, HiOutlineArchive, HiOutlineDocumentText, HiOutlineExternalLink } from 'react-icons/hi';

const DashboardPage = () => {
  const { isAdmin } = useAuth();
  const [parts, setParts] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalParts, setTotalParts] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDownloadMenu(false);
      }
    };
    if (showDownloadMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDownloadMenu]);

  // Download Modal state
  const [downloadStatus, setDownloadStatus] = useState(null); // 'preparing', 'downloading', 'complete', 'error'
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [downloadTotalBytes, setDownloadTotalBytes] = useState(0);
  const [serverProgress, setServerProgress] = useState({ current: 0, total: 0, type: '' });
  const [spreadsheetUrl, setSpreadsheetUrl] = useState(null);
  const pollIntervalRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Clear polling and abort on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  const startPolling = () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      try {
        const { data } = await API.get('/parts/export/status');
        setServerProgress(data);
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 5000); // 5s interval is more stable for rate limiters
  };

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const handleCancelExport = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    stopPolling();
    setDownloadStatus(null);
    toast('Export cancelled', { icon: '🛑' });
  };


  // 300ms debounce for search input (snappier)
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search);
    }, 600);
    return () => clearTimeout(handler);
  }, [search]);

  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [editPart, setEditPart] = useState(null);
  const [deletePart, setDeletePart] = useState(null);
  const [imagePart, setImagePart] = useState(null);

  // Simple cache for prefetched pages to avoid redundant network hits
  const prefetchCache = useRef({});

  const prefetchPage = useCallback(async (targetPage) => {
    if (targetPage < 1 || targetPage > totalPages || targetPage === page) return;
    if (prefetchCache.current[targetPage]) return;

    try {
      const { data } = await API.get('/parts', {
        params: { page: targetPage, limit: 25, search: debouncedSearch },
      });
      prefetchCache.current[targetPage] = data.parts;
    } catch (err) {
      // Fail silently for pre-fetching
    }
  }, [totalPages, page, debouncedSearch]);

  const fetchParts = useCallback(async () => {
    // If we have cached data from a prefetch, use it immediately
    if (prefetchCache.current[page]) {
      setParts(prefetchCache.current[page]);
      // We still might want to re-fetch in background to keep fresh, 
      // but for speed we show cached first
    }

    setLoading(true);
    try {
      const { data } = await API.get('/parts', {
        params: { page, limit: 25, search: debouncedSearch },
      });
      setParts(data.parts);
      setTotalPages(data.totalPages);
      setTotalParts(data.totalParts);
      // Update cache
      prefetchCache.current[page] = data.parts;
    } catch (err) {
      toast.error('Failed to load parts');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  // Fetch on mount and when page/search changes
  useEffect(() => {
    fetchParts();
  }, [fetchParts]);

  // Reset page and cache when search term changes
  useEffect(() => {
    setPage(1);
    prefetchCache.current = {};
  }, [debouncedSearch]);

  const handleDownloadZip = async () => {
    setDownloadStatus('preparing');
    setDownloadedBytes(0);
    setDownloadTotalBytes(0);
    setServerProgress({ current: 0, total: 0, type: 'ZIP' });
    startPolling();
    abortControllerRef.current = new AbortController();
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await API.get(`/parts/export/zip?token=${user.token}`, {
        responseType: 'blob',
        signal: abortControllerRef.current.signal,
        timeout: 900000, // 15 min timeout for very large exports
        onDownloadProgress: (progressEvent) => {
          if (progressEvent.loaded > 0) {
            setDownloadStatus('downloading');
            setDownloadedBytes(progressEvent.loaded);
            if (progressEvent.total) {
              setDownloadTotalBytes(progressEvent.total);
            }
          }
        }
      });

      setDownloadStatus('complete');

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 're-parts-images.zip');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      toast.success('Download finished!');
      stopPolling();

      // Close modal gracefully
      setTimeout(() => setDownloadStatus(null), 2500);
    } catch (err) {
      stopPolling();
      setDownloadStatus('error');
      toast.error('Failed to download images');
      setTimeout(() => setDownloadStatus(null), 3500);
    }
  };

  const handleDownloadExcel = async () => {
    setDownloadStatus('preparing');
    setDownloadedBytes(0);
    setDownloadTotalBytes(0);
    setServerProgress({ current: 0, total: 0, type: 'Excel' });
    setShowDownloadMenu(false);
    startPolling();
    abortControllerRef.current = new AbortController();
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await API.get(`/parts/export/excel?token=${user.token}`, {
        responseType: 'blob',
        signal: abortControllerRef.current.signal,
        timeout: 900000, // 15 min timeout
        onDownloadProgress: (progressEvent) => {
          if (progressEvent.loaded > 0) {
            setDownloadStatus('downloading');
            setDownloadedBytes(progressEvent.loaded);
            if (progressEvent.total) {
              setDownloadTotalBytes(progressEvent.total);
            }
          }
        }
      });

      setDownloadStatus('complete');

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 're-parts-list.xlsx');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      toast.success('Excel Download finished!');
      stopPolling();

      // Close modal gracefully
      setTimeout(() => setDownloadStatus(null), 2500);
    } catch (err) {
      stopPolling();
      setDownloadStatus('error');
      toast.error('Failed to download Excel report');
      setTimeout(() => setDownloadStatus(null), 3500);
    }
  };

  const handleExportGoogleSheets = async () => {
    setShowDownloadMenu(false);

    // Check if we have an access token
    const accessToken = localStorage.getItem('google_access_token');

    if (!accessToken) {
      toast('Please login with Google to export', { icon: '🔑' });
      try {
        const { data } = await API.get('/parts/export/google/auth-url');
        if (data.url) {
          window.location.href = data.url;
        }
      } catch (err) {
        toast.error('Failed to start Google login');
      }
      return;
    }

    setDownloadStatus('preparing');
    setSpreadsheetUrl(null);
    setServerProgress({ current: 10, total: 100, type: 'Google Sheets', message: 'Connecting to Google Drive...' });

    try {
      // Simulate progress since Google API is a single call
      const steps = [
        { progress: 20, message: 'Authenticating with Google API...' },
        { progress: 40, message: 'Finding or Creating Spreadsheet...' },
        { progress: 60, message: 'Generating Part Records & Formulas...' },
        { progress: 85, message: 'Applying Professional Formatting...' },
      ];

      let currentStep = 0;
      const interval = setInterval(() => {
        if (currentStep < steps.length) {
          setServerProgress({
            current: steps[currentStep].progress,
            total: 100,
            type: 'Google Sheets',
            message: steps[currentStep].message
          });
          currentStep++;
        } else {
          clearInterval(interval);
        }
      }, 1500);

      const { data } = await API.post('/parts/export/google-sheets', { accessToken });

      clearInterval(interval);
      setServerProgress({ current: 100, total: 100, type: 'Google Sheets', message: 'Export Complete!' });
      setSpreadsheetUrl(data.spreadsheetUrl);
      setDownloadStatus('complete');
      toast.success('Exported to Google Sheets!');

      setTimeout(() => {
        setDownloadStatus(null);
        setSpreadsheetUrl(null);
      }, 8000); // Leave it open longer so they can click it
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 400) {
        localStorage.removeItem('google_access_token');
        toast.error('Google session expired. Please try again.');
      } else {
        toast.error(err.response?.data?.message || 'Failed to export to Google Sheets');
      }
      setDownloadStatus(null);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Navbar />

      <main
        style={{
          maxWidth: '1500px',
          margin: '0 auto',
          padding: '24px',
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            marginBottom: '20px',
          }}
        >
          {/* Title row */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Parts Inventory</h1>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {isAdmin && (
                <div style={{ position: 'relative' }} ref={dropdownRef}>
                  <button
                    onClick={() => setShowDownloadMenu(!showDownloadMenu)}
                    className="btn-ghost"
                    disabled={downloadStatus !== null}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      opacity: downloadStatus !== null ? 0.6 : 1,
                    }}
                    id="download-dropdown-btn"
                  >
                    <HiOutlineDownload size={16} />
                    Download
                  </button>

                  {showDownloadMenu && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        marginTop: '8px',
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                        zIndex: 50,
                        minWidth: '200px',
                        overflow: 'hidden',
                        animation: 'slideDown 0.2s ease',
                      }}
                    >
                      <button
                        onClick={() => {
                          setShowDownloadMenu(false);
                          handleDownloadZip();
                        }}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '12px 16px',
                          background: 'none',
                          border: 'none',
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          fontSize: '0.95rem',
                          color: 'var(--text-primary)',
                          transition: 'background 0.2s',
                        }}
                        onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                        onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        <HiOutlineArchive size={18} /> ZIP Archive
                      </button>
                      <button
                        onClick={handleDownloadExcel}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '12px 16px',
                          background: 'none',
                          border: 'none',
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          fontSize: '0.95rem',
                          color: 'var(--text-primary)',
                          transition: 'background 0.2s',
                        }}
                        onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                        onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        <HiOutlineDocumentText size={18} /> Excel Report
                      </button>
                      <button
                        onClick={handleExportGoogleSheets}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '12px 16px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          fontSize: '0.95rem',
                          color: 'var(--text-primary)',
                          transition: 'background 0.2s',
                        }}
                        onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                        onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        <HiOutlineExternalLink size={18} /> Google Sheets
                      </button>
                    </div>
                  )}
                </div>
              )}
              <button
                onClick={() => setShowAddModal(true)}
                className="btn-primary"
                id="add-part-btn"
              >
                <HiOutlinePlus size={18} />
                Add Part
              </button>
            </div>
          </div>

          {/* Search */}
          <SearchBar value={search} onChange={setSearch} />
        </div>

        {/* Loading overlay */}
        {loading && (
          <div
            style={{
              textAlign: 'center',
              padding: '40px',
              color: 'var(--text-muted)',
              fontSize: '0.9rem',
              width: '100%',
            }}
          >
            <div
              style={{
                width: '36px',
                height: '36px',
                border: '3px solid var(--border)',
                borderTopColor: 'var(--accent)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
                margin: '0 auto 12px',
              }}
            />
            Loading parts...
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        {/* Parts table */}
        {!loading && (
          <PartTable
            parts={parts}
            page={page}
            totalPages={totalPages}
            totalParts={totalParts}
            onPageChange={setPage}
            onPrefetch={prefetchPage}
            onImageClick={(part) => setImagePart(part)}
            onEdit={(part) => setEditPart(part)}
            onDelete={(part) => setDeletePart(part)}
            onRefresh={fetchParts}
          />
        )}
      </main>

      {/* Modals */}
      {showAddModal && (
        <AddPartModal
          onClose={() => setShowAddModal(false)}
          onSuccess={fetchParts}
        />
      )}

      {editPart && (
        <EditPartModal
          part={editPart}
          onClose={() => setEditPart(null)}
          onSuccess={fetchParts}
        />
      )}

      {deletePart && (
        <DeletePartModal
          part={deletePart}
          onClose={() => setDeletePart(null)}
          onSuccess={fetchParts}
        />
      )}

      {imagePart && (
        <ImageModal
          imageUrl={imagePart.imageUrl}
          partNumber={imagePart.partNumber}
          onClose={() => setImagePart(null)}
        />
      )}

      <DownloadProgressModal
        isOpen={downloadStatus !== null}
        status={downloadStatus}
        downloadedBytes={downloadedBytes}
        totalBytes={downloadTotalBytes}
        totalImages={totalParts}
        serverProgress={serverProgress}
        spreadsheetUrl={spreadsheetUrl}
        onCancel={handleCancelExport}
      />
    </div>
  );
};

export default DashboardPage;
