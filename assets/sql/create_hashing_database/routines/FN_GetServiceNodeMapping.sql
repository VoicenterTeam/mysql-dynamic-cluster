create
    definer = root@localhost function FN_GetServiceNodeMapping() returns json
BEGIN
    RETURN (
        SELECT JSON_OBJECTAGG(
            JSON_OBJECT(
                "ServiceID", ns.service_id,
                "NodeID", ns.node_id,
            )
        ) FROM node_services ns;
    );
END;
