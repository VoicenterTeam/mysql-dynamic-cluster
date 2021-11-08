create
    definer = root@localhost procedure SP_NodeServiceUpdate(IN _NodeID tinyint, IN _ServiceID smallint)
BEGIN
    INSERT INTO node_services (service_id, node_id)
    VALUES (_ServiceID, _NodeID)
    ON DUPLICATE KEY UPDATE node_id=_NodeID;
END;
