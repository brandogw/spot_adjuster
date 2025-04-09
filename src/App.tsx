import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

const GRID_ROWS = 16;
const GRID_COLS = 24;
const CIRCLE_RADIUS = 25;

interface Spot {
  id: number;
  x: number;
  y: number;
}

interface PlateMetadata {
  set_index: number;
  plate_num: number;
  spot_location: string;
  from_block: number;
  estradiol_nm: number;
  threeat_mm: number;
  foa: number;
  selection: string;
}

interface SpotMetadata {
  from_block: number;
  well: string;
  base_strain: string;
  receptor: string;
  anchor: string;
  nanobody: string;
  negsel: string;
  dilution: string;
  notes: string;
}

const getWellID = (id: number): string => {
  const row = String.fromCharCode(65 + Math.floor(id / GRID_COLS));
  const col = (id % GRID_COLS) + 1;
  return `${row}${col}`;
};

const cropSites = [
  [0, 0, 1000, 1500],
  [995, 0, 1995, 1500],
  [0, 1511, 1000, 3011],
  [995, 1511, 1995, 3011],
];

const App: React.FC = () => {
  const [processedImages, setProcessedImages] = useState<string[]>([]);
  const [spotsPerImage, setSpotsPerImage] = useState<Spot[][]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [metadata, setMetadata] = useState<PlateMetadata[]>([]);
  const [spotMetadata, setSpotMetadata] = useState<SpotMetadata[]>([]);
  const imageRef = useRef<HTMLImageElement>(null);

  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [dragMode, setDragMode] = useState<'move' | 'resize-tl' | 'resize-br' | null>(null);
  const [showFill, setShowFill] = useState(true);
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const initialSpots = useRef<Spot[]>([]);
  const originalSpots = useRef<Spot[][]>([]);
  const undoStack = useRef<Spot[][][]>([]);
  const redoStack = useRef<Spot[][][]>([]);
  const clipboard = useRef<Spot[] | null>(null);

  useEffect(() => {
    if (imageRef.current) {
      setImageSize({
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
      });
    }
  }, [currentIndex, processedImages]);


  const handleMultipleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(file => file.type.startsWith('image/'));
    const sortedFiles = files.sort((a, b) => {
      const aNum = parseInt(a.name.match(/Set(\d+)/)?.[1] || '0', 10);
      const bNum = parseInt(b.name.match(/Set(\d+)/)?.[1] || '0', 10);
      return aNum - bNum;
    });

    const images: string[] = [];
    const allSpots: Spot[][] = [];

    for (let file of sortedFiles) {
      const fileUrl = URL.createObjectURL(file);
      const img = new Image();
      img.src = fileUrl;

      await new Promise<void>((resolve) => {
        img.onload = () => {
          for (let quadrant = 0; quadrant < 4; quadrant++) {
            const [x0, y0, x1, y1] = cropSites[quadrant];
            const canvas = document.createElement('canvas');
            canvas.width = y1 - y0;
            canvas.height = x1 - x0;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate((270 * Math.PI) / 180);
            ctx.scale(-1, -1);
            ctx.translate(-canvas.height / 2, -canvas.width / 2);

            ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
            images.push(canvas.toDataURL('image/jpeg'));
            allSpots.push(generatePixelBasedGrid());
          }
          resolve();
        };
      });
    }
    setProcessedImages(images);
    setSpotsPerImage(allSpots);
    originalSpots.current = JSON.parse(JSON.stringify(allSpots));
    setCurrentIndex(0);
  };

  const handleCornerResizeStart = (mode: 'resize-tl' | 'resize-br') => (e: React.MouseEvent) => {
    setDragMode(mode);
    dragStart.current = { x: e.clientX, y: e.clientY };
    initialSpots.current = [...spotsPerImage[currentIndex]];
  };

  const handleGroupDragStart = (e: React.MouseEvent) => {
    setDragMode('move');
    dragStart.current = { x: e.clientX, y: e.clientY };
    initialSpots.current = [...spotsPerImage[currentIndex]];
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!dragMode) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;

    setSpotsPerImage(prev => {
      const updated = [...prev];
      const original = initialSpots.current;

      if (dragMode === 'move') {
        updated[currentIndex] = original.map((s) => ({ x: s.x + dx, y: s.y + dy, id: s.id }));
      } else {
        const box = getBoundingBox(original);
        const anchor = dragMode === 'resize-tl' ? box.bottomRight : box.topLeft;
        const moving = dragMode === 'resize-tl' ? box.topLeft : box.bottomRight;

        const scaleX = (moving.x + dx - anchor.x) / (moving.x - anchor.x);
        const scaleY = (moving.y + dy - anchor.y) / (moving.y - anchor.y);

        updated[currentIndex] = original.map((s) => ({
          ...s,
          x: anchor.x + (s.x - anchor.x) * scaleX,
          y: anchor.y + (s.y - anchor.y) * scaleY,
        }));
      }
      return updated;
    });
  };

  const handleSpotMetadataUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const lines = text.trim().split('\n');
    const meta: SpotMetadata[] = lines.slice(1).map(line => {
      const [from_block,well,base_strain,receptor,anchor,nanobody,negsel,dilution,notes      ] = line.split(',');
      return {
        from_block: parseInt(from_block),
        well,
        base_strain,
        receptor,
        anchor,
        nanobody,
        negsel,
        dilution,
        notes
      };
    });
    console.log("Parsed spot metadata:", meta);
    setSpotMetadata(meta);
  };

  const handleMetadataUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
  
    const text = await file.text();
    const lines = text.trim().split('\n');
    const meta: PlateMetadata[] = lines.slice(1).map(line => {
      const [set_index,plate_num,spot_location,from_block,estradiol_nm,threeat_mm,foa,selection] = line.split(',');
      return {
        set_index: parseInt(set_index),
        plate_num: parseInt(plate_num),
        spot_location,
        from_block,
        estradiol_nm,
        threeat_mm,
        foa,
        selection
      };
    });
    setMetadata(meta);
  };

  const handleMouseUp = () => setDragMode(null);

  const handleReset = () => {
    setSpotsPerImage(prev => {
      const updated = [...prev];
      updated[currentIndex] = [...originalSpots.current[currentIndex]];
      return updated;
    });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const delta = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        const previous = undoStack.current.pop();
        if (previous) {
          redoStack.current.push(JSON.parse(JSON.stringify(spotsPerImage)));
          setSpotsPerImage(JSON.parse(JSON.stringify(previous)));
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        const next = redoStack.current.pop();
        if (next) {
          undoStack.current.push(JSON.parse(JSON.stringify(spotsPerImage)));
          setSpotsPerImage(JSON.parse(JSON.stringify(next)));
        }
        return;
      }
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        clipboard.current = JSON.parse(JSON.stringify(spotsPerImage[currentIndex]));
        return;
      }
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (clipboard.current) {
          undoStack.current.push(JSON.parse(JSON.stringify(spotsPerImage)));
          redoStack.current = [];
          setSpotsPerImage(prev => {
            const updated = [...prev];
            updated[currentIndex] = JSON.parse(JSON.stringify(clipboard.current));
            return updated;
          });
        }
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setShowFill(prev => !prev);
        return;
      }

      if (e.key === 'ArrowLeft') dx = -delta;
      if (e.key === 'ArrowRight') dx = delta;
      if (e.key === 'ArrowUp') dy = -delta;
      if (e.key === 'ArrowDown') dy = delta;
      if (e.key === 'a' || e.key === 'A') {
        setCurrentIndex(i => Math.max(i - 1, 0));
        return;
      }

      if (e.key === 'd' || e.key === 'D') {
        setCurrentIndex(i => Math.min(i + 1, processedImages.length - 1));
        return;
      }
      if (e.key === 'w' || e.key === 'W') {
        setCurrentIndex(i => Math.min(i + 4, processedImages.length - 1));
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        setCurrentIndex(i => Math.max(i - 4, 0));
        return;
      }
      if (dx !== 0 || dy !== 0) {
        e.preventDefault();
        undoStack.current.push(JSON.parse(JSON.stringify(spotsPerImage)));
        redoStack.current = [];
        setSpotsPerImage(prev => {
          const updated = [...prev];
          updated[currentIndex] = prev[currentIndex].map(spot => ({
            ...spot,
            x: spot.x + dx,
            y: spot.y + dy
          }));
          return updated;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [spotsPerImage, currentIndex]);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode]);

  const exportAllCoordinates = () => {
    const exportData = spotsPerImage.map((spots, index) => {
      const coordinates = spots.map(s => {
        const row = String.fromCharCode(65 + Math.floor(s.id / GRID_COLS));
        const col = (s.id % GRID_COLS) + 1;
        const well = `${row}${col}`;
        return { id: s.id + 1, x: Math.round(s.x), y: Math.round(s.y), well };
      });
      return { plate: index + 1, coordinates };
    });
  
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'all_well_coordinates.json';
    link.click();
  };

  const exportAllCoordinatesAsCSV = () => {
    const headers = ['plate', 'well', 'x_index', 'y_index', 'well_position'];
    const rows = [headers.join(',')];
  
    spotsPerImage.forEach((spots, plateIndex) => {
      spots.forEach((s) => {
        const row = String.fromCharCode(65 + Math.floor(s.id / GRID_COLS));
        const col = (s.id % GRID_COLS) + 1;
        const well = `${row}${col}`;
        const line = [
          plateIndex + 1,
          well,
          Math.round(s.x),
          Math.round(s.y),
          s.id + 1
        ].join(',');
        rows.push(line);
      });
    });
  
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'well_coordinates.csv';
    link.click();
  };

  const getSetForSpot = (id: number): 'A' | 'B' | 'C' | 'D' => {
    const row = Math.floor(id / GRID_COLS);
    const col = id % GRID_COLS;
    if (row % 2 === 0 && col % 2 === 0) return 'A';
    if (row % 2 === 0 && col % 2 === 1) return 'B';
    if (row % 2 === 1 && col % 2 === 0) return 'C';
    return 'D';
  };
  
  const setColors = {
    A: 'rgba(255, 99, 132, 0.2)',
    B: 'rgba(54, 162, 235, 0.2)',
    C: 'rgba(255, 206, 86, 0.2)',
    D: 'rgba(75, 192, 192, 0.2)'
  };

  const exportAsZip = async () => {
    const zip = new JSZip();

    spotsPerImage.forEach((spots, plateIndex) => {
      const row = ['plate,well,x_index,y_index,well_position'];
      spots.forEach((s) => {
        const r = String.fromCharCode(65 + Math.floor(s.id / GRID_COLS));
        const c = (s.id % GRID_COLS) + 1;
        const well = `${r}${c}`;
        row.push([plateIndex + 1, well, Math.round(s.x), Math.round(s.y), s.id + 1].join(','));
      });

      zip.file(`coordinates/plate_${plateIndex + 1}.csv`, row.join('\n'));

      const plateNum = plateIndex + 1;
      const meta = metadata.find(m => m.plate_num === plateNum && m.spot_location === 'A');
      const cleanSelection = meta.selection.replace(/[^\w.-]/g, '');
      const plateName = meta
        ? `P${plateNum}_B${meta.from_block}_${Number(meta.estradiol_nm).toFixed(1)}E_${Number(meta.threeat_mm).toFixed(1)}AT_${Number(meta.foa).toFixed(2)}F_${cleanSelection}.jpg`
        : `plate_${plateNum}.jpg`;

      const imageData = processedImages[plateIndex];
      const base64 = imageData.split(',')[1];
      const mime = imageData.split(',')[0].split(':')[1].split(';')[0];
      zip.file(`images/${plateName}`, base64, { base64: true });
      if (!zip.files['combined_coordinates.csv']) {
        zip.file('combined_coordinates.csv', `${row.join('\n')}\n`);
      } else {
        const current = zip.file('combined_coordinates.csv').async('string');
        zip.file('combined_coordinates.csv', current.then(content => content + '\n' + row.slice(1).join('\n')));
      }
    });
    
    if (spotMetadata.length > 0) {
      const headers = Object.keys(spotMetadata[0]);
      const rows = [headers.join(',')];
      for (const row of spotMetadata) {
        rows.push(headers.map(h => String(row[h as keyof SpotMetadata])).join(','));
      }
      zip.file('spots.csv', rows.join('\n'));
    }

    if (metadata.length > 0) {
      const headers = Object.keys(metadata[0]);
      const rows = [headers.join(',')];
      for (const row of metadata) {
        rows.push(headers.map(h => String(row[h as keyof PlateMetadata])).join(','));
      }
      zip.file('plates.csv', rows.join('\n'));
    }    

    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, 'spot_data.zip');
  };

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragMode]);

  return (
    <div className="app-container">
      {processedImages.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '40px 20px',
          color: '#333',
          fontSize: '16px',
          lineHeight: '1.6',
          maxWidth: '700px',
          margin: 'auto'
        }}>
          <h2>Well Plate Overlay Tool</h2>
          <p>Welcome! To get started, follow these steps:</p>
          <ol style={{ textAlign: 'left', display: 'inline-block' }}>
            <li><strong>Upload Plate Scan Images</strong> — Click the top <em>Browse</em> button and upload your scanned images (in sets like <code>Set001.jpg</code>, etc).</li>
            <li><strong>Upload Metadata CSV</strong> — Click the second <em>Browse</em> button to upload your <code>plates.csv</code> file for experimental conditions.</li>
            <li>The app will automatically crop, rotate, and detect wells for each image quadrant.</li>
            <li>You can adjust the well layout, assign metadata, and export images and coordinates.</li>
          </ol>
          <p><em>Once you upload the images, you’ll see overlays and navigation controls.</em></p>
        </div>
      )}
      <div className="upload-section">
        <label htmlFor="image-upload">📷 1. Upload Plate Scan Images  </label>
        <input
          id="image-upload"
          type="file"
          accept="image/*"
          multiple
          onChange={handleMultipleImageUpload}
          className="upload-input"
        />
        <label htmlFor="metadata-upload"> 🍽️ 2. Upload plates.csv </label>
        <input
          id="metadata-upload"
          type="file"
          accept=".csv"
          onChange={handleMetadataUpload}
          className="upload-input"
        />
        <label htmlFor="spotmetadata-upload">🔴 3. Upload spots.csv  </label>
        <input
          id="spotmetadata-upload"
          type="file"
          accept=".csv"
          onChange={handleSpotMetadataUpload}
          className="upload-input"
        />
      </div>
      {processedImages.length > 0 && (
        <div className="image-container">
          <img
            src={processedImages[currentIndex]}
            ref={imageRef}
            onLoad={() => {
              if (imageRef.current) {
                setImageSize({
                  width: imageRef.current.naturalWidth,
                  height: imageRef.current.naturalHeight,
                });
              }
            }}
            alt="Processed plate"
            className="plate-image"
          />
          <svg
            className="svg-overlay"
            width={imageSize.width}
            height={imageSize.height}
          >
            {spotsPerImage[currentIndex]
              ?.map((spot) => {
                const set = getSetForSpot(spot.id);
                const plateNum = currentIndex + 1;
                const meta = metadata.find(m => m.plate_num === plateNum && m.spot_location === set);
                if (!meta) return null;
                return (
                  <g key={spot.id}>
                    <circle
                      cx={spot.x}
                      cy={spot.y}
                      r={CIRCLE_RADIUS}
                      fill={showFill ? setColors[set] : 'transparent'}
                      stroke={showFill ? "blue" : "transparent"}
                      strokeWidth={1}
                      onMouseDown={(e) => {
                        undoStack.current.push(JSON.stringify(spotsPerImage));
                        redoStack.current = [];
                        setDragMode('move');
                        dragStart.current = { x: e.clientX, y: e.clientY };
                        initialSpots.current = [...spotsPerImage[currentIndex]];
                        e.stopPropagation();
                      }}
                      style={{ pointerEvents: 'all' }}
                    >
                      <title>
                        {(() => {
                          const set = getSetForSpot(spot.id);
                          const plateNum = currentIndex + 1;
                          const meta = metadata.find(m => m.plate_num === plateNum && m.spot_location === set);
                          const wellID384 = getWellID(spot.id);

                          const map384to96 = (well: string, set: string): string | null => {
                            const row = well[0];
                            const col = parseInt(well.slice(1));
                            const rowIndex = row.charCodeAt(0) - 65;
                            const colIndex = col - 1;

                            if (set === 'A' && rowIndex % 2 === 0 && colIndex % 2 === 0)
                              return String.fromCharCode(65 + rowIndex / 2) + (Math.floor(colIndex / 2) + 1);
                            if (set === 'B' && rowIndex % 2 === 0 && colIndex % 2 === 1)
                              return String.fromCharCode(65 + rowIndex / 2) + (Math.floor(colIndex / 2) + 1);
                            if (set === 'C' && rowIndex % 2 === 1 && colIndex % 2 === 0)
                              return String.fromCharCode(65 + Math.floor(rowIndex / 2)) + (Math.floor(colIndex / 2) + 1);
                            if (set === 'D' && rowIndex % 2 === 1 && colIndex % 2 === 1)
                              return String.fromCharCode(65 + Math.floor(rowIndex / 2)) + (Math.floor(colIndex / 2) + 1);
                            return null;
                          };

                          const wellID96 = map384to96(wellID384, set);
                          const sm = spotMetadata.find(s =>
                            String(s.from_block).trim() === String(meta?.from_block).trim() &&
                            s.well.trim().toUpperCase() === wellID96?.trim().toUpperCase()
                          );

                          return sm
                            ? `Spot ID: ${wellID384}\nFrom Block: ${sm.from_block}\nOriginal Well: ${sm.well}\nStrain: ${sm.base_strain}\nNanobody: ${sm.nanobody}\nReceptor: ${sm.receptor}\nAnchor: ${sm.anchor}\nDilution: ${sm.dilution}\nNotes: ${sm.notes}`
                            : `Spot ID: ${wellID384}`;
                        })()}
                      </title>
                    </circle>
                    <text
                      x={spot.x}
                      y={spot.y + 4}
                      fontSize="10"
                      textAnchor="middle"
                      fill="black"
                      pointerEvents="none"
                    >
                      {getWellID(spot.id)}
                    </text>
                  </g>
                );
              })}
            <rect
              {...getGroupBoundingBox(spotsPerImage[currentIndex] || [])}
              fill="transparent"
              stroke="red"
              strokeDasharray="4"
            />
            <circle
              cx={getBoundingBox(spotsPerImage[currentIndex] || []).topLeft.x - 10}
              cy={getBoundingBox(spotsPerImage[currentIndex] || []).topLeft.y - 10}
              r={8}
              fill="red"
              onMouseDown={handleCornerResizeStart('resize-tl')}
              style={{ cursor: 'nwse-resize' }}
            />
            <circle
              cx={getBoundingBox(spotsPerImage[currentIndex] || []).bottomRight.x + 10}
              cy={getBoundingBox(spotsPerImage[currentIndex] || []).bottomRight.y + 10}
              r={8}
              fill="green"
              onMouseDown={handleCornerResizeStart('resize-br')}
              style={{ cursor: 'nwse-resize' }}
            />
          </svg>

          {metadata.length > 0 && (
            <div style={{
              position: 'absolute',
              bottom: '10px',
              right: '10px',
              background: '#fff',
              padding: '10px',
              border: '1px solid #ccc',
              borderRadius: '6px',
              fontSize: '12px',
              boxShadow: '0 0 5px rgba(0,0,0,0.1)'
            }}>
              {(() => {
                  const plateNum = currentIndex + 1;
                  const metaForSetA = metadata.find(m => m.plate_num === plateNum && m.spot_location === 'A');
                  const metaForSetB = metadata.find(m => m.plate_num === plateNum && m.spot_location === 'B');
                  const metaForSetC = metadata.find(m => m.plate_num === plateNum && m.spot_location === 'C');
                  const metaForSetD = metadata.find(m => m.plate_num === plateNum && m.spot_location === 'D');
                  return (
                    <>
                      <div><strong>Plate {plateNum}</strong></div>
                      <div style={{ marginTop: '0.5em' }}>
                        <strong>Spot Set Legend:</strong>
                        <div>
                          <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(255, 99, 132, 0.3)', marginRight: '6px' }}></span>
                          Set A {metaForSetA ? `(Block: ${metaForSetA.from_block})` : ''}
                        </div>
                        <div>
                          <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(54, 162, 235, 0.3)', marginRight: '6px' }}></span>
                          Set B {metaForSetB ? `(Block: ${metaForSetB.from_block})` : ''}
                        </div>
                        <div>
                          <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(255, 206, 86, 0.3)', marginRight: '6px' }}></span>
                          Set C {metaForSetC ? `(Block: ${metaForSetC.from_block})` : ''}
                        </div>
                        <div>
                          <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(75, 192, 192, 0.3)', marginRight: '6px' }}></span>
                          Set D {metaForSetD ? `(Block: ${metaForSetD.from_block})` : ''}
                        </div>
                        <div style={{ marginTop: '0.5em' }}>
                          <strong>Display:</strong>
                          <div>
                            <span style={{
                              display: 'inline-block',
                              width: '12px',
                              height: '12px',
                              backgroundColor: showFill ? '#666' : 'transparent',
                              border: '1px solid #333',
                              marginRight: '6px'
                            }}></span>
                            {showFill ? 'Spot Fill ON' : 'Spot Fill OFF'} (Toggle with Spacebar)
                          </div>
                        </div>
                      </div>
                      {metadata.find(m => m.plate_num === plateNum && m.spot_location === getSetForSpot(spotsPerImage[currentIndex][0].id)) && (
                        <>
                          <div><strong>Estradiol:</strong> {metadata.find(m => m.plate_num === plateNum && m.spot_location === getSetForSpot(spotsPerImage[currentIndex][0].id))!.estradiol_nm} nM</div>
                          <div><strong>3-AT:</strong> {metadata.find(m => m.plate_num === plateNum && m.spot_location === getSetForSpot(spotsPerImage[currentIndex][0].id))!.threeat_mm} mM</div>
                          <div><strong>5-FOA:</strong> {metadata.find(m => m.plate_num === plateNum && m.spot_location === getSetForSpot(spotsPerImage[currentIndex][0].id))!.foa}</div>
                          <div><strong>Media:</strong> {metadata.find(m => m.plate_num === plateNum && m.spot_location === getSetForSpot(spotsPerImage[currentIndex][0].id))!.selection}</div>
                        </>
                      )}
                    </>
                  );
                })()}
            </div>
          )}

          <div className="controls">
            <button onClick={() => setCurrentIndex((i) => Math.max(i - 1, 0))}>Prev</button>
            <span>{currentIndex + 1} / {processedImages.length}</span>
            <button onClick={() => setCurrentIndex((i) => Math.min(i + 1, processedImages.length - 1))}>Next</button>
            <button onClick={handleReset}>Reset</button>
          </div>

          <div className="shortcut-help" style={{ marginTop: '1em', padding: '1em', background: '#f0f0f0', borderRadius: '8px', fontSize: '14px' }}>
            <strong>Keyboard Shortcuts:</strong>
            <ul style={{ listStyle: 'disc', paddingLeft: '1.2em' }}>
              <li><strong>A / D</strong>: Navigate between plates</li>
              <li><strong>W / S</strong>: Jump forward/backward 4 plates</li>
              <li><strong>Arrow Keys</strong>: Move spots (hold <strong>Shift</strong> for faster movement)</li>
              <li><strong>⌘+C / Ctrl+C</strong>: Copy current spot layout</li>
              <li><strong>⌘+V / Ctrl+V</strong>: Paste layout to current plate</li>
              <li><strong>⌘+Z / Ctrl+Z</strong>: Undo</li>
              <li><strong>⌘+Y / Ctrl+Y</strong>: Redo</li>
            </ul>
          </div>
        </div>
      )}

      {processedImages.length > 0 && (
        <>
          <button className="export-button" onClick={exportAsZip}>
            Export ZIP (Images + CSV)
          </button>
        </>
      )}
    </div>
  );
};


function generatePixelBasedGrid(): Spot[] {
  const column_start = 145;
  const column_spacing = (1377 - 151) / 23;
  const columns = Array.from({ length: 24 }, (_, i) => Math.round(column_start + i * column_spacing));
  const row_start = 100;
  const row_spacing = (890 - 95) / 15;
  const rows = Array.from({ length: 16 }, (_, i) => Math.round(row_start + i * row_spacing));

  const spots: Spot[] = [];
  let id = 0;
  for (let row of rows) {
    for (let col of [...columns].reverse()) {
      spots.push({ id: id++, x: col, y: row });
    }
  }
  return spots;
}

function getBoundingBox(spots: Spot[]) {
  const xs = spots.map((s) => s.x);
  const ys = spots.map((s) => s.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    topLeft: { x: minX, y: minY },
    bottomRight: { x: maxX, y: maxY },
    width: maxX - minX,
    height: maxY - minY,
  };
}

function getGroupBoundingBox(spots: Spot[]) {
  const box = getBoundingBox(spots);
  return {
    x: box.topLeft.x,
    y: box.topLeft.y,
    width: box.width,
    height: box.height,
  };
}


export default App;
