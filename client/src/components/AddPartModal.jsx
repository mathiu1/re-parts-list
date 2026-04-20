import { useState, useEffect, useRef } from 'react';
import { HiOutlineX, HiOutlineUpload, HiOutlinePhotograph, HiOutlineCamera, HiOutlineSearch } from 'react-icons/hi';
import imageCompression from 'browser-image-compression';
import API from '../api/axios';
import toast from 'react-hot-toast';

const AddPartModal = ({ onClose, onSuccess }) => {
  const [partNumber, setPartNumber] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [uomDimension, setUomDimension] = useState(''); // Keep for DB compatibility
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [movingType, setMovingType] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionRef = useRef(null);

  // Click outside to close suggestions
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (suggestionRef.current && !suggestionRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search for suggestions
  useEffect(() => {
    if (partNumber.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const handler = setTimeout(async () => {
      try {
        const { data } = await API.get(`/parts/search-lookup?q=${encodeURIComponent(partNumber)}`);
        setSuggestions(data);
        
        // Don't show if the input exactly matches a suggestion already
        const isExactMatch = data.some(s => s.upperPartNumber === partNumber.trim().toUpperCase());
        if (data.length > 0 && !isExactMatch) {
          setShowSuggestions(true);
        } else {
          setShowSuggestions(false);
        }
      } catch (err) {
        console.error('Suggestion fetch error:', err);
      }
    }, 1000);

    return () => clearTimeout(handler);
  }, [partNumber]);

  // Manual Lookup Logic
  const handleLookup = async (pNum = partNumber) => {
    if (!pNum || pNum.length < 3) return;
    setLookingUp(true);
    setShowSuggestions(false);
    // ... rest of logic remains same but use pNum
    setDescription('');
    setLocation('');
    setUomDimension('');
    setModel('');
    setColor('');
    setSupplierName('');
    setMovingType('');
    
    try {
      const { data } = await API.get(`/parts/lookup/${encodeURIComponent(pNum)}`);
      if (data) {
        setDescription(data.description || '');
        setLocation(data.location || '');
        setUomDimension(data.uomDimension || '');
        setModel(data.model || '');
        setColor(data.color || '');
        setSupplierName(data.supplierName || '');
        setMovingType(data.movingType || '');
        toast.success('Part details found!', { id: 'lookup-success' });
      }
    } catch (err) {
      toast.error('Part not found in master list', { id: 'lookup-error' });
    } finally {
      setLookingUp(false);
    }
  };

  const selectSuggestion = (part) => {
    setPartNumber(part.partNumber);
    setDescription(part.description || '');
    setLocation(part.location || '');
    setUomDimension(part.uomDimension || '');
    setModel(part.model || '');
    setColor(part.color || '');
    setSupplierName(part.supplierName || '');
    setMovingType(part.movingType || '');
    setShowSuggestions(false);
    toast.success('Part details loaded!');
  };

  const onPartNumberChange = (val) => {
    // Allow only letters, numbers, and /
    const cleanVal = val.replace(/[^a-zA-Z0-9/]/g, '');
    setPartNumber(cleanVal);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLookup();
    }
  };

  const handleImageChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Compress the image
    setCompressing(true);
    try {
      const options = {
        maxSizeMB: 0.1,
        maxWidthOrHeight: 1280,
        useWebWorker: true,
      };
      const compressed = await imageCompression(file, options);
      setImageFile(compressed);

      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target.result);
      reader.readAsDataURL(compressed);

      toast.success(
        `Compressed: ${(file.size / 1024).toFixed(0)}kb → ${(compressed.size / 1024).toFixed(0)}kb`
      );
    } catch (err) {
      toast.error('Image compression failed');
      console.error(err);
    } finally {
      setCompressing(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!partNumber.trim()) return toast.error('Part number is required');
    if (!imageFile) return toast.error('Image is required');

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('partNumber', partNumber.trim());
      formData.append('description', description.trim());
      formData.append('location', location.trim());
      formData.append('uomDimension', uomDimension.trim());
      formData.append('model', model.trim());
      formData.append('color', color.trim());
      formData.append('supplierName', supplierName.trim());
      formData.append('movingType', movingType.trim());
      formData.append('image', imageFile);

      await API.post('/parts', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      toast.success('Part added successfully!');
      onSuccess();
      onClose();
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to add part';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      onClick={onClose}
      className="modal-overlay"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-card modal-content-responsive responsive-padding animate-slide-up"
      >
        <div className="bottom-sheet-handle" />
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '20px',
          }}
        >
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Add New Part</h2>
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-hover)',
              border: 'none',
              borderRadius: '8px',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            <HiOutlineX size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Part Number */}
          <label
            style={{
              display: 'block',
              marginBottom: '6px',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            Part Number *
          </label>
          <div style={{ position: 'relative', marginBottom: '24px' }} ref={suggestionRef}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={partNumber}
                onChange={(e) => onPartNumberChange(e.target.value)}
                onKeyDown={handleKeyDown}
                className="input-field"
                placeholder="Part number"
                style={{ flex: 1, marginBottom: 0 }}
                id="add-part-number"
                autoFocus
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => handleLookup()}
                disabled={lookingUp || partNumber.length < 3}
                style={{
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0 16px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  opacity: (lookingUp || partNumber.length < 3) ? 0.6 : 1,
                  transition: 'all 0.2s ease',
                }}
              >
                {lookingUp ? '...' : 'Check'}
              </button>
            </div>

            {/* Suggestions Dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  marginTop: '4px',
                  boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
                  zIndex: 100,
                  maxHeight: '200px',
                  overflowY: 'auto',
                }}
              >
                {suggestions.map((s, idx) => (
                  <div
                    key={idx}
                    onClick={() => selectSuggestion(s)}
                    style={{
                      padding: '10px 14px',
                      cursor: 'pointer',
                      borderBottom: idx === suggestions.length - 1 ? 'none' : '1px solid var(--border)',
                      fontSize: '0.85rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                    }}
                    onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                    onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
                  >
                    <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{s.partNumber}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Part Description */}
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Part Description
          </label>
          <div style={{ position: 'relative', marginBottom: '24px' }}>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`input-field ${lookingUp ? 'skeleton-pulse' : ''}`}
              placeholder={lookingUp ? "" : "Auto-filled description"}
              style={{ marginBottom: 0 }}
            />
          </div>

          <div className="form-row-responsive">
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Location
              </label>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className={`input-field ${lookingUp ? 'skeleton-pulse' : ''}`}
                placeholder={lookingUp ? "" : "Bin Location"}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={`input-field ${lookingUp ? 'skeleton-pulse' : ''}`}
                placeholder={lookingUp ? "" : "Model info"}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Color
              </label>
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className={`input-field ${lookingUp ? 'skeleton-pulse' : ''}`}
                placeholder={lookingUp ? "" : "Part color"}
              />
            </div>
          </div>

          <div className="form-row-responsive">
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Supplier Name
              </label>
              <input
                type="text"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                className={`input-field ${lookingUp ? 'skeleton-pulse' : ''}`}
                placeholder={lookingUp ? "" : "Supplier info"}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                Moving Type
              </label>
              <input
                type="text"
                value={movingType}
                onChange={(e) => setMovingType(e.target.value)}
                className={`input-field ${lookingUp ? 'skeleton-pulse' : ''}`}
                placeholder={lookingUp ? "" : "LIVE/DEAD etc"}
              />
            </div>
          </div>

          {/* Image Upload */}
          <label
            style={{
              display: 'block',
              marginBottom: '6px',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            Part Image *
          </label>

          {preview ? (
            <div style={{ marginBottom: '16px', position: 'relative' }}>
              <img
                src={preview}
                alt="Preview"
                style={{
                  width: '100%',
                  height: '180px',
                  objectFit: 'cover',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setImageFile(null);
                  setPreview(null);
                }}
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '8px',
                  background: 'rgba(0,0,0,0.6)',
                  border: 'none',
                  borderRadius: '50%',
                  width: '28px',
                  height: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: '#fff',
                }}
              >
                <HiOutlineX size={14} />
              </button>
            </div>
          ) : compressing ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '2px dashed var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '32px',
                marginBottom: '16px',
                textAlign: 'center',
              }}
            >
              <div style={{ color: 'var(--accent)', fontSize: '0.85rem', fontWeight: 600 }}>
                Compressing image...
              </div>
            </div>
          ) : (
            <div className="form-row-responsive">
              {/* Take Photo */}
              <label
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(59, 130, 246, 0.05)',
                  border: '1.5px solid rgba(59, 130, 246, 0.2)',
                  borderRadius: '12px',
                  padding: '24px 12px',
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.15)';
                  e.currentTarget.style.borderColor = 'var(--accent)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
                  e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.2)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  background: 'rgba(59, 130, 246, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '12px'
                }}>
                  <HiOutlineCamera size={24} style={{ color: 'var(--accent)' }} />
                </div>
                <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 600 }}>Take Photo</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleImageChange}
                  style={{ display: 'none' }}
                />
              </label>

              {/* Open Gallery */}
              <label
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(139, 92, 246, 0.05)',
                  border: '1.5px solid rgba(139, 92, 246, 0.2)',
                  borderRadius: '12px',
                  padding: '24px 12px',
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(139, 92, 246, 0.15)';
                  e.currentTarget.style.borderColor = '#8b5cf6';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(139, 92, 246, 0.05)';
                  e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.2)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  background: 'rgba(139, 92, 246, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '12px'
                }}>
                  <HiOutlinePhotograph size={24} style={{ color: '#8b5cf6' }} />
                </div>
                <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 600 }}>Gallery</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            className="btn-primary"
            disabled={loading || compressing}
            style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
            id="submit-add-part"
          >
            <HiOutlineUpload size={18} />
            {loading ? 'Uploading...' : 'Add Part'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default AddPartModal;
